// pi-code-hygiene: after every successful edit or write, run codehygiene on the file.
//
// It hooks the public `tool_result` event. In "shadow" mode (the default) it only records
// timings and counts and never touches the tool result. In "on" mode it waits for the analysis
// and appends a short, non-imperative note to the result. It never marks a result as an error,
// never asks the agent to continue, and fails silently: a broken install must not slow the
// agent down or change what it sees.
//
// codehygiene itself (Python + numpy) is installed outside this package, under
// $PI_CODE_HYGIENE_HOME (default %LOCALAPPDATA%/pi-hygiene):
//   venv/             Python with numpy
//   src/codehygiene/  checkout of brianbell-x/codehygiene, pinned to a commit
//   manifest.sha256   hashes of the files that get loaded, in `sha256sum` format
//   mode              optional: "shadow", "on" or "off"
//   state/            shadow log and salt
// PI_CODE_HYGIENE_MODE overrides the mode file; PI_CODE_HYGIENE_PYTHON overrides the interpreter.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Extensions the codehygiene README documents. Its source accepts a few more.
const EXTENSIONS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".c", ".h",
  ".cc", ".cpp", ".cxx", ".hpp", ".zig", ".java", ".cs", ".lua",
]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".venv", "venv", "dist", "build", "target", "__pycache__"]);
// The squiggle kinds codehygiene 0.5.0 can emit; anything else is reported as "other" so a
// future version cannot put free text into the log or the note.
const KINDS = new Set([
  "deep_nesting", "poor_naming", "noisy_comment", "swallowed_error",
  "dense_line", "special_casing", "duplicate_block", "cramped_layout",
]);
const MODES = new Set(["shadow", "on", "off"]);

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
  let ticketCounter = 0;
  let installState; // undefined until first use, then "" (usable) or the reason it is not

  function installProblem() {
    if (installState === undefined) installState = checkInstall(home, python, packageDir);
    return installState || undefined;
  }

  // Resolves to the findings to show (possibly empty) and logs one record. If something
  // unexpected throws, the caller logs it instead.
  async function analyze(file, base, ticket, cwd) {
    try {
      const skip = skipReason(file, cwd) ?? installProblem();
      if (skip) return skipped(base, skip);

      const before = snapshot(file);
      if (!before) return skipped(base, "unreadable");
      const record = { ...base, bytes: before.bytes };

      // The time limit also covers waiting for a slot, so `on` mode never holds an edit longer.
      const queuedAt = performance.now();
      const release = await limiter.acquire().catch(() => undefined);
      if (!release) return skipped(record, "busy");
      try {
        if (shutdown.signal.aborted) return skipped(record, "shutdown");
        // A later edit of the same file replaced this job while it waited; only the last one counts.
        if (latestTicket.get(file) !== ticket) return skipped(record, "superseded");
        const startedAt = performance.now();
        const remaining = RUN_TIMEOUT_MS - (startedAt - queuedAt);
        if (remaining < MIN_RUN_MS) return skipped(record, "busy");

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
        log.write({
          ...record,
          ...counts,
          queue_ms: Math.round(startedAt - queuedAt),
          run_ms: Math.round(performance.now() - startedAt),
          stale,
        });
        return counts.outcome === "ok" && !stale ? findings : [];
      } finally {
        release();
      }
    } finally {
      if (latestTicket.get(file) === ticket) latestTicket.delete(file);
    }
  }

  function skipped(record, reason) {
    log.write({ ...record, outcome: "skipped", skip: reason });
    return [];
  }

  pi.on("tool_result", (event, ctx) => {
    if (event?.isError || (event?.toolName !== "edit" && event?.toolName !== "write")) return;
    const mode = readMode(home);
    if (mode === "off") return;
    const file = targetOf(event.input, ctx?.cwd);
    if (!file || !EXTENSIONS.has(extname(file).toLowerCase())) return;

    const ticket = ++ticketCounter;
    latestTicket.set(file, ticket);
    const base = { mode, tool: event.toolName, ext: extname(file).toLowerCase(), path: log.pseudonym(file) };
    const run = () =>
      analyze(file, base, ticket, ctx.cwd).catch((error) => {
        log.write({ ...base, outcome: "internal_error", error: error instanceof Error ? error.name : "unknown" });
        return [];
      });

    // Shadow: defer all work so the hook returns before any file or process activity.
    if (mode === "shadow") {
      setImmediate(run);
      return;
    }
    return run().then((findings) => {
      const text = formatNote(findings);
      if (!text || lastNotice.get(file) === text) return undefined;
      lastNotice.set(file, text);
      return { content: [...(event.content ?? []), { type: "text", text }] };
    });
  });

  pi.on("session_shutdown", () => shutdown.abort());
}

// The environment variable wins when valid, then the mode file. A missing file means the
// default, but a file that says something else means a typo, and a typo must not turn an
// intended "off" into running processes.
function readMode(home) {
  const requested = process.env.PI_CODE_HYGIENE_MODE;
  if (MODES.has(requested)) return requested;
  let fromFile;
  try {
    fromFile = readFileSync(join(home, "mode"), "utf8").trim();
  } catch {
    return "shadow";
  }
  return MODES.has(fromFile) ? fromFile : "off";
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
function skipReason(file, cwd) {
  const inside = relative(cwd, file);
  const parts = (inside.startsWith("..") || isAbsolute(inside) ? file : inside).split(sep);
  if (parts.some((part) => IGNORED_DIRECTORIES.has(part.toLowerCase()))) return "ignored_dir";
  // codehygiene treats an argument with * ? [ as a glob and crashes on an absolute one.
  if (/[*?[]/.test(file)) return "glob_chars";
  try {
    const stats = statSync(file);
    if (!stats.isFile()) return "not_file";
    if (stats.size > MAX_FILE_BYTES) return "too_large";
  } catch {
    return "unreadable";
  }
  return undefined;
}

function snapshot(file, maxBytes = MAX_FILE_BYTES) {
  try {
    if (statSync(file).size > maxBytes) return undefined;
    const content = readFileSync(file);
    return { sha: createHash("sha256").update(content).digest("hex"), bytes: content.length };
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
    findings: findings.slice(0, MAX_FINDINGS_SHOWN),
  };
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
