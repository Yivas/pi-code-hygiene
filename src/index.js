// pi-code-hygiene: after every successful edit or write, run codehygiene on the file.
//
// It hooks the public `tool_result` event. In "shadow" mode (the default) it only records
// timings and counts and never touches the tool result. In "on" mode it waits for the analysis
// and appends a short, non-imperative note to the result. "fix" is the assertive variant (see
// fix.js): it reports only findings in the code the agent wrote in this run, with a recipe for each,
// adds a short rule to the system prompt, and stops after two rounds per file. It never marks a
// result as an error, never asks the agent to continue, and fails silently: a broken install
// must not slow the agent down or change what it sees.
//
//
// codehygiene itself (Python + numpy) is installed outside this package, under
// $PI_CODE_HYGIENE_HOME (default %LOCALAPPDATA%/pi-hygiene):
//   venv/             Python with numpy
//   src/codehygiene/  checkout of brianbell-x/codehygiene, pinned to a commit
//   manifest.sha256   hashes of the files that get loaded, in `sha256sum` format
//   mode              optional: "shadow", "on", "fix" or "off"
//   state/            shadow log and salt
// PI_CODE_HYGIENE_MODE overrides the mode file; PI_CODE_HYGIENE_PYTHON overrides the interpreter.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createFixTurn, FIX_GUIDELINE } from "./fix.js";
import { fingerprint, splitLines } from "./lines.js";

// Extensions the codehygiene README documents. Its source accepts a few more.
const EXTENSIONS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".c", ".h",
  ".cc", ".cpp", ".cxx", ".hpp", ".zig", ".java", ".cs", ".lua",
]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", "target", "__pycache__"]);
// The squiggle kinds codehygiene 0.5.1 can emit; anything else is reported as "other" so a
// future version cannot put free text into the log or the note.
const KINDS = new Set([
  "deep_nesting", "poor_naming", "noisy_comment", "swallowed_error",
  "dense_line", "special_casing", "duplicate_block", "cramped_layout",
]);
const MODES = new Set(["shadow", "on", "fix", "off"]);

const THRESHOLD = 0.55;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_RUNNING = 2;
const MAX_QUEUED = 8;
const RUN_TIMEOUT_MS = 3000;
const MIN_RUN_MS = 500;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_FINDINGS_SHOWN = 3;
const MAX_LOG_BYTES = 1024 * 1024;

export default function codeHygiene(pi) {
  const home = process.env.PI_CODE_HYGIENE_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "pi-hygiene");
  const python =
    process.env.PI_CODE_HYGIENE_PYTHON ??
    join(home, "venv", process.platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python"));
  const packageDir = join(home, "src", "codehygiene");
  const log = createLog(join(home, "state"));
  const limiter = createLimiter(MAX_RUNNING, MAX_QUEUED);
  const shutdown = new AbortController();
  const latestTicket = new Map();
  const lastNotice = new Map();
  const previousFingerprints = new Map(); // file -> fingerprints of its last analysis
  let fixTurn = createFixTurn(); // `fix` mode state; a new user prompt starts a new one
  let ticketCounter = 0;
  let warnedMode = false; // a rejected mode value is recorded once per session

  // The mode, and a one-time record when the configured value could not be understood. The
  // record reaches the log only: saying it in the tool result would put harness configuration
  // in front of the agent.
  function mode() {
    const { mode: current, rejected } = readMode(home);
    if (rejected !== undefined && !warnedMode) {
      warnedMode = true;
      log.write({ outcome: "bad_mode", value: /^[\x20-\x7e]{1,16}$/.test(rejected) ? rejected : "unprintable" });
    }
    return current;
  }
  let installState; // undefined until first use, then "" (usable) or the reason it is not

  function installProblem() {
    if (installState === undefined) installState = checkInstall(home, python, packageDir);
    return installState || undefined;
  }

  // Resolves to the text of the note to show ("" for none) and logs one record. If something
  // unexpected throws, the caller logs it instead.
  async function analyze(file, base, ticket, cwd, wrote) {
    try {
      const skip = skipReason(file, cwd) ?? installProblem();
      if (skip) return skipped(base, skip);

      const before = snapshot(file, MAX_FILE_BYTES, true);
      if (!before) return skipped(base, "unreadable");
      const record = { ...base, bytes: before.bytes };

      // The time limit also covers waiting for a slot, so `on` mode never holds an edit longer.
      const queuedAt = performance.now();
      const release = await limiter.acquire().catch(() => undefined);
      if (!release) return dropped(record, "busy", file);
      try {
        if (shutdown.signal.aborted) return skipped(record, "shutdown");
        // A later edit of the same file replaced this job while it waited; only the last one counts,
        // and it compares against the file as that edit left it.
        if (latestTicket.get(file) !== ticket) return skipped(record, "superseded");
        const startedAt = performance.now();
        const remaining = RUN_TIMEOUT_MS - (startedAt - queuedAt);
        if (remaining < MIN_RUN_MS) return dropped(record, "busy", file);

        // The path is absolute, so it cannot be read as an option, and pi.exec uses no shell.
        // -I ignores PYTHON* variables and the user site; -B writes no .pyc files.
        const result = await pi.exec(
          python,
          ["-I", "-B", packageDir, file, "--json", "--no-update-check", "--threshold", String(THRESHOLD)],
          { signal: shutdown.signal, timeout: Math.round(remaining), maxBuffer: MAX_OUTPUT_BYTES },
        );
        const outcome = describeRun(result, shutdown.signal.aborted);
        // Findings describe the file as it was analyzed; if it changed meanwhile they are stale.
        const stale = snapshot(file)?.sha !== before.sha;
        const { findings, ...counts } = outcome;
        const usable = counts.outcome === "ok" && !stale;

        let note = "";
        let stats = {};
        if (counts.outcome === "ok") {
          const lines = splitLines(before.text);
          const fingerprints = new Set(findings.map((item) => fingerprint(item.kind, lines, item.line)).filter(Boolean));
          // A stale analysis describes text that is no longer in the file: it joins no comparison.
          if (!stale) {
            stats = compare(previousFingerprints.get(file), fingerprints);
            previousFingerprints.set(file, fingerprints);
          }
          if (usable && base.mode === "on") {
            note = formatNote(findings.slice(0, MAX_FINDINGS_SHOWN));
            stats.shown = note ? Math.min(findings.length, MAX_FINDINGS_SHOWN) : 0;
          } else if (usable && base.mode === "fix") {
            const review = fixTurn.review(file, lines, findings, { wrote });
            note = review.text;
            stats = { ...stats, ...review.stats, shown: review.findings.length, suppressed: review.suppressed };
          } else if (base.mode === "fix") {
            observeLater(file);
          }
        } else if (base.mode === "fix") {
          // A failed analysis leaves the same problem: the edit happened anyway.
          observeLater(file);
        }
        // "superseded" needs nothing: the newer edit of the same file is analyzed, and that
        // analysis advances the comparison.
        log.write({
          ...record,
          ...counts,
          ...stats,
          queue_ms: Math.round(startedAt - queuedAt),
          run_ms: Math.round(performance.now() - startedAt),
          stale,
        });
        return note;
      } finally {
        release();
      }
    } finally {
      if (latestTicket.get(file) === ticket) latestTicket.delete(file);
    }
  }

  // The edit happened but its analysis cannot be used (the file changed while it ran, it failed,
  // or no slot was free): the next comparison has to start from the file as it is now, or an
  // unrelated edit would count as the re-check of a note it never answered.
  function observeLater(file) {
    const now = snapshot(file, MAX_FILE_BYTES, true);
    if (now) fixTurn.observe(file, splitLines(now.text));
  }

  // An edit the extension decided not to analyze: no baseline was taken for it either, so there is
  // nothing to compare against and nothing to record beyond the reason.
  function skipped(record, reason) {
    log.write({ ...record, outcome: "skipped", skip: reason });
    return "";
  }

  // An edit that was going to be analyzed and was dropped without one, for lack of capacity.
  function dropped(record, reason, file) {
    if (record.mode === "fix") observeLater(file);
    return skipped(record, reason);
  }

  // Before an edit of a file in `fix` mode: remember the file as it is, so that later "the code you
  // wrote" means the difference. A file that does not exist yet has no lines to compare against.
  // Pi turns an error thrown here into a blocked tool call, so nothing may escape.
  pi.on("tool_call", (event, ctx) => {
    try {
      if (event?.toolName !== "edit" && event?.toolName !== "write") return;
      if (mode() !== "fix") return;
      const file = targetOf(event.input, ctx?.cwd);
      if (!file || !EXTENSIONS.has(extname(file).toLowerCase()) || ignoredPath(file, ctx.cwd)) return;
      fixTurn.begin(file, baselineOf(file));
    } catch {
      // No baseline means no notes for this file, never a failed edit.
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (event?.isError || (event?.toolName !== "edit" && event?.toolName !== "write")) return;
    const currentMode = mode();
    if (currentMode === "off") return;
    const file = targetOf(event.input, ctx?.cwd);
    if (!file || !EXTENSIONS.has(extname(file).toLowerCase())) return;

    const ticket = ++ticketCounter;
    latestTicket.set(file, ticket);
    const base = { mode: currentMode, tool: event.toolName, ext: extname(file).toLowerCase(), path: log.pseudonym(file) };
    const run = () =>
      analyze(file, base, ticket, ctx.cwd, event.toolName === "write").catch((error) => {
        log.write({ ...base, outcome: "internal_error", error: error instanceof Error ? error.name : "unknown" });
        return "";
      });

    // Shadow: defer all work so the hook returns before any file or process activity.
    if (currentMode === "shadow") {
      setImmediate(run);
      return;
    }
    return run().then((text) => {
      // `on` skips a note identical to the last one for the file; `fix` tracks what it showed.
      if (!text || (currentMode === "on" && lastNotice.get(file) === text)) return undefined;
      lastNotice.set(file, text);
      return { content: [...(event.content ?? []), { type: "text", text }] };
    });
  });

  // A run starts with a submitted prompt and gets fresh rounds and budgets. In `fix` mode the rule
  // joins the system prompt, once, as the same constant text every time.
  pi.on("before_agent_start", (event) => {
    fixTurn = createFixTurn();
    const options = event?.systemPromptOptions;
    if (!options || mode() !== "fix") return;
    options.promptGuidelines ??= [];
    if (Array.isArray(options.promptGuidelines) && !options.promptGuidelines.includes(FIX_GUIDELINE)) {
      options.promptGuidelines.push(FIX_GUIDELINE);
    }
  });

  pi.on("session_shutdown", () => shutdown.abort());
}

// The environment variable wins when valid, then the mode file. A missing file means the
// default, but a file that says something else means a typo, and a typo must not turn an
// intended "off" into running processes. Surrounding space and capital letters are forgiven,
// because "Fix" and "fix\n" are how the file gets written by hand.
//
// Returns the mode, and the value when one was set but not understood, so the caller can say so
// once. A rejected value never starts the mode it names: what applies instead is the next thing
// that is valid, or "off" when the file is set but wrong too, or the default "shadow" when there
// is no file at all. An empty value counts as not set.
function readMode(home) {
  const requested = normalizeMode(process.env.PI_CODE_HYGIENE_MODE) || undefined;
  let configured;
  try {
    configured = normalizeMode(readFileSync(join(home, "mode"), "utf8")) || undefined;
  } catch {
    configured = undefined;
  }

  const wanted = requested && MODES.has(requested) ? requested : undefined;
  const found = configured && MODES.has(configured) ? configured : undefined;
  const rejected = (wanted ? undefined : requested) ?? (found ? undefined : configured);
  if (wanted) return { mode: wanted, rejected };
  if (found) return { mode: found, rejected };
  if (configured) return { mode: "off", rejected };
  return { mode: "shadow", rejected };
}

function normalizeMode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Returns "" when codehygiene can be used, otherwise the reason it cannot. The manifest
// catches accidental changes to the pinned files; it is not an integrity control against
// someone who can write to the install folder, who can rewrite the manifest too.
function checkInstall(home, python, packageDir) {
  if (!existsSync(python)) return "python_missing";
  if (!existsSync(join(packageDir, "__main__.py"))) return "source_missing";
  let manifest;
  try {
    manifest = readFileSync(join(home, "manifest.sha256"), "utf8");
  } catch {
    return "manifest_missing";
  }
  const entries = manifest.split(/\r?\n/).filter(Boolean).map((line) => /^([0-9a-f]{64}) [ *](.+)$/.exec(line));
  if (entries.length === 0 || entries.includes(null)) return "manifest_invalid";
  // The entry point must be pinned, or a manifest listing only the model file would pass.
  if (!entries.some(([, , relative]) => relative === "codehygiene/__main__.py")) return "manifest_invalid";
  for (const [, hash, relative] of entries) {
    const found = snapshot(join(home, "src", relative), 50 * 1024 * 1024);
    if (found?.sha !== hash) return "pin_mismatch";
  }
  return "";
}

// The path Pi gives a tool may start with "@" or "~"; the built-in tools expand both too.
function targetOf(input, cwd) {
  const raw = input?.path;
  if (typeof raw !== "string" || raw === "" || typeof cwd !== "string") return undefined;
  const path = raw.startsWith("@") ? raw.slice(1) : raw;
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(1));
  return resolve(cwd, path);
}

// Only directories below the project count: a checkout that lives under a folder called
// "build" or "dist" must still be analyzed. Windows paths ignore case.
function ignoredPath(file, cwd) {
  const inside = relative(cwd, file);
  const parts = (inside.startsWith("..") || isAbsolute(inside) ? file : inside).split(sep);
  if (parts.some((part) => IGNORED_DIRECTORIES.has(part.toLowerCase()))) return "ignored_dir";
  // codehygiene treats an argument with * ? [ as a glob and crashes on an absolute one.
  if (/[*?[]/.test(file)) return "glob_chars";
  return undefined;
}

function skipReason(file, cwd) {
  const ignored = ignoredPath(file, cwd);
  if (ignored) return ignored;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return "not_file";
    if (stats.size > MAX_FILE_BYTES) return "too_large";
  } catch {
    return "unreadable";
  }
  return undefined;
}

// The text is kept only when asked for, to match findings with lines; it is never logged.
function snapshot(file, maxBytes = MAX_FILE_BYTES, withText = false) {
  try {
    if (statSync(file).size > maxBytes) return undefined;
    const content = readFileSync(file);
    const sha = createHash("sha256").update(content).digest("hex");
    return withText ? { sha, bytes: content.length, text: content.toString("utf8") } : { sha, bytes: content.length };
  } catch {
    return undefined;
  }
}

// Without --check codehygiene exits 0 whenever it produced a result, so any other exit is a crash.
function describeRun(result, shuttingDown) {
  // pi.exec kills the process and sets killed when output exceeds maxBuffer, so check that first.
  if (result.truncated) return { outcome: "truncated", findings: [] };
  if (result.killed || result.code === null) return { outcome: shuttingDown ? "aborted" : "timeout", findings: [] };
  if (result.code !== 0) return { outcome: "error", exit: result.code, findings: [] };
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { outcome: "bad_json", findings: [] };
  }
  if (typeof parsed?.score !== "number" || !Array.isArray(parsed.squiggles)) return { outcome: "bad_json", findings: [] };

  const kinds = {};
  const findings = [];
  for (const squiggle of parsed.squiggles) {
    const kind = KINDS.has(squiggle?.kind) ? squiggle.kind : "other";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (typeof squiggle?.probability === "number" && Number.isInteger(squiggle?.line)) {
      findings.push({ line: squiggle.line, kind, probability: squiggle.probability });
    }
  }
  findings.sort((a, b) => b.probability - a.probability);
  return {
    outcome: "ok",
    score: parsed.score,
    squiggles: parsed.squiggles.length,
    kinds,
    max_probability: findings[0]?.probability ?? 0,
    findings,
  };
}

// Counts for the log: against the previous analysis of the same file, how many findings were
// resolved, persist or are new. Counts only.
function compare(previous, current) {
  if (!previous) return {};
  const persisted = [...current].filter((fp) => previous.has(fp)).length;
  return { resolved: previous.size - persisted, persisted, new_findings: current.size - persisted };
}

// The file's lines before an edit: null when it does not exist yet, undefined when it cannot be
// read or is too large to analyze.
function baselineOf(file) {
  try {
    const stats = statSync(file);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined;
    return splitLines(readFileSync(file, "utf8"));
  } catch (error) {
    return error?.code === "ENOENT" ? null : undefined;
  }
}

// Plain facts and no instruction to fix: codehygiene is a preview with known false positives.
function formatNote(findings) {
  if (findings.length === 0) return "";
  const lines = findings.map((f) => `  line ${f.line}: ${f.kind} (${f.probability.toFixed(2)})`);
  return [
    "[code-hygiene] Heuristic readability notes for this file (codehygiene preview; false positives are expected):",
    ...lines,
    "Optional. Working code does not need rewriting to silence these.",
  ].join("\n");
}

// Runs at most `limit` tasks at once and refuses new waiters beyond `maxQueued`.
function createLimiter(limit, maxQueued) {
  let active = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return {
    acquire() {
      if (active < limit) {
        active++;
        return Promise.resolve(release);
      }
      if (waiting.length >= maxQueued) return Promise.reject(new Error("busy"));
      return new Promise((resolveSlot) => waiting.push(() => resolveSlot(release)));
    },
  };
}

// The log holds counts and timings only: no code, no diagnostic text and no real paths. Path
// IDs are an HMAC with a local salt. The salt has no access protection on Windows beyond the
// folder's permissions, so this hides paths from casual reading of the log, not from someone
// who can read the whole folder.
function createLog(directory) {
  let salt;
  const file = join(directory, "shadow.jsonl");

  function prepare() {
    if (salt) return;
    mkdirSync(directory, { recursive: true });
    const saltFile = join(directory, "salt.bin");
    // "wx" makes concurrent first runs agree on one salt: the loser reads the winner's file.
    try {
      writeFileSync(saltFile, randomBytes(16), { flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    salt = readFileSync(saltFile);
  }

  // Another Pi process may hold the log open; on Windows the rename then fails, so truncate.
  function rotate() {
    try {
      renameSync(file, `${file}.1`);
    } catch {
      writeFileSync(file, "");
    }
  }

  return {
    pseudonym(value) {
      try {
        prepare();
        return createHmac("sha256", salt).update(value).digest("hex").slice(0, 12);
      } catch {
        return "unavailable";
      }
    },
    write(record) {
      try {
        prepare();
        if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) rotate();
        appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...record })}\n`);
      } catch {
        // Logging must never affect the agent.
      }
    },
  };
}
