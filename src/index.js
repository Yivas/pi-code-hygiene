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
//   config.json       mode, threshold and limits; see config.js
//   mode              optional legacy file, still read, never written
//   state/            shadow log and salt
// PI_CODE_HYGIENE_MODE overrides the configured mode; PI_CODE_HYGIENE_PYTHON overrides the interpreter.
//
// Every log line carries the version of the module that wrote it, and start-up writes one line per
// session with that version and whether the copy on disk is another one. `/reload` does not
// re-import a packaged ESM extension (Node caches the module per URL), so that line is how a
// mismatch shows up instead of being guessed.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createCommand } from "./command.js";
import { DEFAULTS, formatThreshold, readConfig, resolveHome, writeConfig } from "./config.js";
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

const MAX_FILE_BYTES = 200 * 1024;
const MAX_RUNNING = 2;
const MAX_QUEUED = 8;
const RUN_TIMEOUT_MS = 3000;
const MIN_RUN_MS = 500;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_SNAPSHOTS = 256;

// Read once, when the module is evaluated: a module that is already in memory keeps reporting the
// version that was on disk when it was loaded, which is exactly what is running.
const VERSION = readOwnVersion();
const LOADED_AT = new Date().toISOString();

// One activation per load. The newest one wins and older ones go inert, so a second copy in
// another location cannot register a second set of hooks. `/reload` emits session_shutdown, which
// marks this activation closed before the next one starts.
const ACTIVATION = Symbol.for("pi-code-hygiene.activation");
let activations = 0;

export default function codeHygiene(pi) {
  const activation = { id: `${process.pid}-${++activations}`, version: VERSION, closed: false };
  const previous = globalThis[ACTIVATION];
  globalThis[ACTIVATION] = activation;
  const active = () => globalThis[ACTIVATION] === activation;

  // Resolved per call, so a test can point the install folder somewhere else at any time.
  let runtimeCache;
  function runtime() {
    const home = resolveHome();
    const python =
      process.env.PI_CODE_HYGIENE_PYTHON ??
      join(home, "venv", process.platform === "win32" ? join("Scripts", "python.exe") : join("bin", "python"));
    const key = `${home}|${python}`;
    if (runtimeCache?.key !== key) {
      runtimeCache = {
        key,
        home,
        python,
        packageDir: join(home, "src", "codehygiene"),
        log: createLog(join(home, "state")),
      };
    }
    return runtimeCache;
  }

  if (previous && !previous.closed) {
    runtime().log.write({ outcome: "duplicate_load", v: VERSION, previous: previous.version });
  }

  const limiter = createLimiter(MAX_RUNNING, MAX_QUEUED);
  // Replaced at every session start: a runtime that is reused for another session must not inherit
  // the abort of the one that ended, or every later analysis would be recorded as aborted.
  let shutdown = new AbortController();
  const latestTicket = new Map();
  const lastNotice = new Map();
  const previousFingerprints = new Map(); // file -> fingerprints of its last analysis
  const snapshots = new Map(); // toolCallId -> configuration snapshot taken for that call
  let fixTurn = createFixTurn(); // `fix` mode state; a new user prompt starts a new one
  let ticketCounter = 0;
  let session = newSession();

  function newSession() {
    return { warned: new Set() };
  }

  // The configuration for this call. A rejected value is recorded once per session and reaches the
  // log only: saying it in the tool result would put harness configuration in front of the agent.
  function configuration() {
    const snapshot = readConfig(runtime().home);
    if (snapshot.problems.length > 0) remember("bad_config", { problem: snapshot.problems[0] });
    for (const item of snapshot.rejected) {
      if (item.key === "mode") remember("bad_mode", { value: item.value });
      else remember("bad_config", { setting: item.key, value: item.value });
    }
    return snapshot;
  }

  // A call that is blocked after tool_call never reaches tool_result, so the map is capped: an
  // orphaned snapshot costs a few bytes and nothing else, but it must not accumulate all session.
  function storeSnapshot(toolCallId, snapshot) {
    if (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
    snapshots.set(toolCallId, snapshot);
  }

  function remember(outcome, payload) {
    // One record per setting, so a bad threshold and a bad round count both get named once.
    const key = payload?.setting ? `${outcome}:${payload.setting}` : outcome;
    if (session.warned.has(key)) return;
    session.warned.add(key);
    runtime().log.write({ outcome, v: VERSION, ...payload });
  }

  // Returns "" when codehygiene can be used, otherwise the reason it cannot. Cached for the
  // process so an edit does not re-hash the install every time; the menu asks for a fresh check.
  let installState;
  function installProblem() {
    if (installState === undefined) installState = checkInstall(runtime());
    return installState || undefined;
  }

  // The one place that builds the codehygiene command line, so the analysis and the menu's check
  // cannot drift apart.
  async function runCodehygiene({ file, thresholdCents, signal, timeout }) {
    const { python, packageDir } = runtime();
    // The path is absolute, so it cannot be read as an option, and pi.exec uses no shell.
    // -I ignores PYTHON* variables and the user site; -B writes no .pyc files.
    const args = [
      "-I", "-B", packageDir, file, "--json", "--no-update-check", "--threshold", formatThreshold(thresholdCents),
    ];
    const startedAt = performance.now();
    const result = await pi.exec(python, args, { signal, timeout: Math.round(timeout), maxBuffer: MAX_OUTPUT_BYTES });
    return { result, ms: Math.round(performance.now() - startedAt) };
  }

  // Resolves to the text of the note to show ("" for none) and logs one record. If something
  // unexpected throws, the caller logs it instead.
  async function analyze(file, base, ticket, cwd, wrote, snapshot) {
    // The controller of this analysis, not whatever `shutdown` points at later: a session that
    // starts in the middle must not change how this record is labelled.
    const controller = shutdown;
    try {
      const skip = skipReason(file, cwd) ?? installProblem();
      if (skip) return skipped(base, skip);

      const before = snapshotOf(file, MAX_FILE_BYTES, true);
      if (!before) return skipped(base, "unreadable");
      const record = { ...base, bytes: before.bytes };

      // The time limit also covers waiting for a slot, so `on` mode never holds an edit longer.
      const queuedAt = performance.now();
      const release = await limiter.acquire().catch(() => undefined);
      if (!release) return dropped(record, "busy", file);
      try {
        if (controller.signal.aborted) return skipped(record, "shutdown");
        // A later edit of the same file replaced this job while it waited; only the last one counts,
        // and it compares against the file as that edit left it.
        if (latestTicket.get(file) !== ticket) return skipped(record, "superseded");
        const startedAt = performance.now();
        const remaining = RUN_TIMEOUT_MS - (startedAt - queuedAt);
        if (remaining < MIN_RUN_MS) return dropped(record, "busy", file);

        const { result } = await runCodehygiene({
          file,
          thresholdCents: snapshot.values.thresholdCents,
          signal: controller.signal,
          timeout: remaining,
        });
        const outcome = describeRun(result, controller.signal.aborted);
        // Findings describe the file as it was analyzed; if it changed meanwhile they are stale.
        const stale = snapshotOf(file)?.sha !== before.sha;
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
            const maxFindings = snapshot.values.maxFindings;
            note = formatNote(findings.slice(0, maxFindings));
            stats.shown = note ? Math.min(findings.length, maxFindings) : 0;
          } else if (usable && base.mode === "fix") {
            const review = fixTurn.review(file, lines, findings, {
              wrote,
              limits: { rounds: snapshot.values.rounds, maxFindings: snapshot.values.maxFindings },
            });
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
        runtime().log.write({
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
    const now = snapshotOf(file, MAX_FILE_BYTES, true);
    if (now) fixTurn.observe(file, splitLines(now.text));
  }

  // An edit the extension decided not to analyze: no baseline was taken for it either, so there is
  // nothing to compare against and nothing to record beyond the reason.
  function skipped(record, reason) {
    runtime().log.write({ ...record, outcome: "skipped", skip: reason });
    return "";
  }

  // An edit that was going to be analyzed and was dropped without one, for lack of capacity.
  function dropped(record, reason, file) {
    if (record.mode === "fix") observeLater(file);
    return skipped(record, reason);
  }

  // Before an edit of a file in `fix` mode: remember the file as it is, so that later "the code you
  // wrote" means the difference. A file that does not exist yet has no lines to compare against.
  // The configuration snapshot taken here is the one the matching tool_result uses.
  // Pi turns an error thrown here into a blocked tool call, so nothing may escape.
  pi.on("tool_call", (event, ctx) => {
    try {
      if (!active()) return;
      if (event?.toolName !== "edit" && event?.toolName !== "write") return;
      const snapshot = configuration();
      if (typeof event.toolCallId === "string") storeSnapshot(event.toolCallId, snapshot);
      if (snapshot.values.mode !== "fix") return;
      const file = targetOf(event.input, ctx?.cwd);
      if (!file || !EXTENSIONS.has(extname(file).toLowerCase()) || ignoredPath(file, ctx.cwd)) return;
      fixTurn.begin(file, baselineOf(file));
    } catch {
      // No baseline means no notes for this file, never a failed edit.
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (!active()) return;
    // Take the snapshot first, even for a failed tool: the call is over and nothing else uses it.
    const taken = typeof event?.toolCallId === "string" ? snapshots.get(event.toolCallId) : undefined;
    if (typeof event?.toolCallId === "string") snapshots.delete(event.toolCallId);
    if (event?.isError || (event?.toolName !== "edit" && event?.toolName !== "write")) return;
    let snapshot = taken;
    if (!snapshot) {
      try {
        snapshot = configuration();
      } catch {
        // A broken reader must not turn a successful edit into a failure; the defaults are safe.
        snapshot = { values: { ...DEFAULTS }, sources: { mode: "default" }, rejected: [], problems: [] };
      }
    }
    const currentMode = snapshot.values.mode;
    if (currentMode === "off") return;
    const file = targetOf(event.input, ctx?.cwd);
    if (!file || !EXTENSIONS.has(extname(file).toLowerCase())) return;

    const { log } = runtime();
    const ticket = ++ticketCounter;
    latestTicket.set(file, ticket);
    const base = {
      v: VERSION,
      mode: currentMode,
      tool: event.toolName,
      ext: extname(file).toLowerCase(),
      path: log.pseudonym(file),
    };
    const run = () =>
      analyze(file, base, ticket, ctx.cwd, event.toolName === "write", snapshot).catch((error) => {
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
    if (!active()) return;
    fixTurn = createFixTurn();
    const options = event?.systemPromptOptions;
    if (!options || configuration().values.mode !== "fix") return;
    options.promptGuidelines ??= [];
    if (Array.isArray(options.promptGuidelines) && !options.promptGuidelines.includes(FIX_GUIDELINE)) {
      options.promptGuidelines.push(FIX_GUIDELINE);
    }
  });

  // One line per session: the version in memory, the version on disk, the mode that applies and
  // where it came from. It is written even in `off` mode, because a line is how you tell that the
  // extension is loaded at all when someone turned it off on purpose.
  pi.on("session_start", (event) => {
    if (!active()) return;
    session = newSession();
    snapshots.clear();
    // A previous shutdown aborted only the controller it saw; a session that starts here gets a
    // live one, so a reused runtime keeps working.
    if (shutdown.signal.aborted) shutdown = new AbortController();
    const snapshot = configuration();
    const disk = readOwnVersion();
    runtime().log.write({
      outcome: "session",
      v: VERSION,
      reason: typeof event?.reason === "string" ? event.reason : "unknown",
      mode: snapshot.values.mode,
      mode_raw: snapshot.rawMode,
      mode_source: snapshot.sources.mode,
      threshold: formatThreshold(snapshot.values.thresholdCents),
      max_findings: snapshot.values.maxFindings,
      rounds: snapshot.values.rounds,
      schema: snapshot.schema,
      loaded_at: LOADED_AT,
      disk_version: disk,
      stale: disk !== VERSION,
    });
  });

  pi.on("session_shutdown", () => {
    activation.closed = true;
    shutdown.abort();
  });

  // A second copy in the same process could try to register the same name; a name clash must not
  // break the load, so it is recorded and the first registration stays in charge.
  try {
    pi.registerCommand?.("hygiene", createCommand(commandDeps()));
  } catch (error) {
    runtime().log.write({
      outcome: "duplicate_command",
      v: VERSION,
      error: error instanceof Error ? error.name : "unknown",
    });
  }

  // What the command needs to read the state of this install. Everything is resolved per call, so
  // a menu that stays open while the environment changes keeps telling the truth.
  function commandDeps() {
    return {
      version: VERSION,
      loadedAt: LOADED_AT,
      runtime,
      configuration,
      diskVersion: () => readOwnVersion(),
      // Deliberately not the cached answer: asking for a check means asking again.
      installCheck: () => {
        const reason = checkInstall(runtime());
        return { ok: reason === "", reason };
      },
      check: async () => {
        const { home } = runtime();
        const sample = join(home, "state", `check-${process.pid}-${Date.now()}.py`);
        try {
          mkdirSync(join(home, "state"), { recursive: true });
          writeFileSync(sample, CHECK_SAMPLE, "utf8");
          const release = await limiter.acquire().catch(() => undefined);
          if (!release) return { ok: false, reason: "busy" };
          try {
            const controller = shutdown;
            const thresholdCents = readConfig(home).values.thresholdCents;
            const run = await runCodehygiene({
              file: sample,
              thresholdCents,
              signal: controller.signal,
              timeout: RUN_TIMEOUT_MS,
            });
            const outcome = describeRun(run.result, controller.signal.aborted);
            return {
              ok: outcome.outcome === "ok",
              outcome: outcome.outcome,
              findings: outcome.findings?.length ?? 0,
              score: outcome.score,
              exit: run.result.code,
              stderr: typeof run.result.stderr === "string" ? run.result.stderr.slice(-400) : "",
              ms: run.ms,
            };
          } finally {
            release();
          }
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.name : "unknown" };
        } finally {
          try {
            unlinkSync(sample);
          } catch {
            // A leftover sample in the state folder is harmless.
          }
        }
      },
      write: (patch) => writeConfig(runtime().home, patch),
      reset: () => writeConfig(runtime().home, { ...DEFAULTS }),
      logSummary: () => readLogSummary(runtime().log.file),
      logWrite: (record) => runtime().log.write({ v: VERSION, ...record }),
    };
  }
}

// A file with one swallowed error and one dense line: enough for a check to prove that codehygiene
// really ran and found something, instead of only proving that a process started.
const CHECK_SAMPLE = [
  "def load(path):",
  "    try:",
  "        return open(path).read()",
  "    except Exception:",
  "        pass",
  "",
].join("\n");

function readOwnVersion() {
  try {
    const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(text);
    if (typeof parsed?.version === "string") return parsed.version;
  } catch {
    // An unreadable manifest means the version is unknown, not that the extension is broken.
  }
  return "unknown";
}

// Returns "" when codehygiene can be used, otherwise the reason it cannot. The manifest catches
// accidental changes to the pinned files; it is not an integrity control against someone who can
// write to the install folder, who can rewrite the manifest too.
function checkInstall({ home, python, packageDir }) {
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
  if (!entries.some(([, , path]) => path === "codehygiene/__main__.py")) return "manifest_invalid";
  for (const [, hash, path] of entries) {
    const found = snapshotOf(join(home, "src", path), 50 * 1024 * 1024);
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
function snapshotOf(file, maxBytes = MAX_FILE_BYTES, withText = false) {
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

// A short summary of the log for the menu: size, last write, counts by outcome and the last lines
// in plain words. Only the last 128 KB are parsed, so a megabyte of history does not become a
// megabyte of work; the counts it reports are the counts of that tail.
function readLogSummary(file, tailLines = 20) {
  const empty = { size: 0, last: undefined, total: 0, outcomes: {}, tail: [] };
  let text;
  let size;
  try {
    size = statSync(file).size;
    const readFrom = Math.max(0, size - 128 * 1024);
    text = readFileSync(file).subarray(readFrom).toString("utf8");
    if (readFrom > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return empty;
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A half-written last line is expected while another process appends.
    }
  }
  const outcomes = {};
  for (const record of records) {
    const key = record.outcome ?? "record";
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }
  return {
    size,
    last: records.at(-1)?.ts,
    total: records.length,
    outcomes,
    tail: records.slice(-tailLines),
  };
}

// The log holds counts, timings and the version that wrote them: no code, no diagnostic text and
// no real paths. Path IDs are an HMAC with a local salt. The salt has no access protection on
// Windows beyond the folder's permissions, so this hides paths from casual reading of the log, not
// from someone who can read the whole folder.
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
    file,
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
