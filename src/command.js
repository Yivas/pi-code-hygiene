// The `/hygiene` command: a menu for the interactive modes, and one action per argument for
// scripts and for runs without a UI.
//
// Everything the command reads comes from the dependencies handed over by index.js, so it needs no
// imports from the host beyond the dialogs and can be tested with a plain object.
// Menu labels and every message are in English: the package is public.

import {
  DEFAULTS,
  formatThreshold,
  MAX_FINDINGS,
  MODES,
  ROUNDS,
  THRESHOLD_CENTS,
  validatePatch,
} from "./config.js";

// A dialog that never gets an answer must not leave the menu hanging, which is what happens in RPC
// when the client does not reply.
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;
const TAIL_LINES = 8;

// Overridable only so a test does not have to wait five minutes for a dialog nobody answers.
let dialogTimeoutMs = DIALOG_TIMEOUT_MS;

const BACK = "Back";
const EXIT = "Exit";

const MENU = {
  STATUS: "Status and diagnostics",
  MODE: "Mode",
  LIMITS: "Threshold and notes",
  INSTALL: "Installation",
  LOG: "Log",
  RESET: "Reset to defaults",
};

const HELP = {
  python_missing: "create the venv in the install folder",
  source_missing: "check out codehygiene at the pinned commit",
  manifest_missing: "regenerate manifest.sha256",
  manifest_invalid: "regenerate manifest.sha256",
  pin_mismatch: "the checkout does not match the manifest",
};

export function createCommand(deps) {
  dialogTimeoutMs = Number.isFinite(deps?.dialogTimeoutMs) ? deps.dialogTimeoutMs : DIALOG_TIMEOUT_MS;
  return {
    description: "Show and change pi-code-hygiene settings",
    handler: async (args, ctx) => {
      const ui = ctx?.hasUI ? ctx.ui : undefined;
      const parsed = parseArgs(args);
      if (!parsed.ok) {
        await say(ui, deps, parsed.error, "warning", "usage");
        return;
      }
      if (parsed.action === "menu") {
        await openMenu(ui, deps);
        return;
      }
      await runAction(parsed, ui, deps);
    },
  };
}

function parseArgs(args) {
  const words = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { ok: true, action: "menu" };
  const [action, first, second] = words;
  if (action === "status") return { ok: true, action: "status" };
  if (action === "check") return { ok: true, action: "check" };
  if (action === "reset") return { ok: true, action: "reset", confirmed: words.includes("--yes") };
  if (action === "mode" && first) return { ok: true, action: "set", patch: { mode: first } };
  if (action === "set" && first && second !== undefined) return { ok: true, action: "set", patch: { [first]: second } };
  return { ok: false, error: usage() };
}

function usage() {
  return [
    "usage: /hygiene [status | mode <shadow|on|fix|off> | set <threshold|maxFindings|rounds> <value> | check | reset --yes]",
    "with no arguments it opens the menu",
  ].join("; ");
}

async function openMenu(ui, deps) {
  if (!ui) {
    // No dialogs here: the log gets the reason, not the text, and that is the whole trace a host
    // without a UI gets. Pi does not dispatch commands in -p, so this is a defensive path.
    await say(ui, deps, statusText(deps), "info", "status");
    return;
  }
  for (;;) {
    const choice = await ask(ui, "select", statusText(deps), Object.values(MENU).concat(EXIT));
    if (choice === undefined || choice === EXIT) return;
    await runMenuItem(choice, ui, deps);
  }
}

async function runMenuItem(choice, ui, deps) {
  if (choice === MENU.STATUS) await say(ui, deps, detailText(deps), "info", "status");
  else if (choice === MENU.MODE) await chooseMode(ui, deps);
  else if (choice === MENU.LIMITS) await chooseLimits(ui, deps);
  else if (choice === MENU.INSTALL) await showInstall(ui, deps);
  else if (choice === MENU.LOG) await say(ui, deps, logText(deps), "info", "log");
  else if (choice === MENU.RESET) await resetToDefaults(ui, deps);
}

async function chooseMode(ui, deps) {
  const snapshot = deps.configuration();
  const labels = MODES.map((mode) => `${mode}${mode === snapshot.values.mode ? "  (current)" : ""}`);
  const choice = await ask(ui, "select", "Mode after every edit", labels.concat(BACK));
  if (!choice || choice === BACK) return;
  const mode = choice.split(/\s+/)[0];
  await save(ui, deps, { mode });
}

async function chooseLimits(ui, deps) {
  for (;;) {
    const snapshot = deps.configuration();
    const options = [
      `Threshold ${formatThreshold(snapshot.values.thresholdCents)}`,
      `Findings per note ${snapshot.values.maxFindings}`,
      `Fix rounds ${snapshot.values.rounds}`,
      BACK,
    ];
    const choice = await ask(ui, "select", "Threshold and notes", options);
    if (!choice || choice === BACK) return;
    if (choice.startsWith("Threshold")) await chooseThreshold(ui, deps);
    else if (choice.startsWith("Findings")) await chooseFindings(ui, deps);
    else await chooseRounds(ui, deps);
  }
}

async function chooseThreshold(ui, deps) {
  const current = deps.configuration().values.thresholdCents;
  const choices = THRESHOLD_CENTS.map((cents) => `${formatThreshold(cents)}${cents === current ? "  (current)" : ""}`);
  const choice = await ask(ui, "select", "Threshold passed to codehygiene", choices.concat(BACK));
  if (!choice || choice === BACK) return;
  await save(ui, deps, { thresholdCents: firstWord(choice) });
}

async function chooseFindings(ui, deps) {
  const current = deps.configuration().values.maxFindings;
  const choices = MAX_FINDINGS.map((value) => `${value}${value === current ? "  (current)" : ""}`);
  const choice = await ask(ui, "select", "Findings per note", choices.concat(BACK));
  if (!choice || choice === BACK) return;
  await save(ui, deps, { maxFindings: firstWord(choice) });
}

async function chooseRounds(ui, deps) {
  const current = deps.configuration().values.rounds;
  const choices = ROUNDS.map(
    (value) => `${value}${value === current ? "  (current)" : ""}${value === 1 ? "  (one note, then quiet)" : ""}`,
  );
  const choice = await ask(ui, "select", "Rounds per file in fix mode", choices.concat(BACK));
  if (!choice || choice === BACK) return;
  await save(ui, deps, { rounds: firstWord(choice) });
}

async function showInstall(ui, deps) {
  const { home, python, packageDir } = deps.runtime();
  const check = deps.installCheck();
  const lines = [
    `install folder: ${home}`,
    `python: ${python}`,
    `codehygiene: ${packageDir}`,
    check.ok ? "install: ok" : `install: ${check.reason} (${HELP[check.reason] ?? "see the README"})`,
    "this screen does not install or update anything",
  ];
  const run = await ask(ui, "confirm", "Run a check now?", lines.join("\n"));
  if (!run) return;
  const result = await deps.check();
  await say(ui, deps, checkText(result), result.ok ? "info" : "warning", result.ok ? "check" : "check_failed");
}

function checkText(result) {
  if (result.ok) {
    return `check: ran in ${result.ms} ms, score ${result.score ?? "?"}, ${result.findings} findings`;
  }
  const tail = result.stderr ? `\n${result.stderr}` : "";
  return `check failed: ${result.reason ?? result.outcome ?? "unknown"}${tail}`;
}

async function resetToDefaults(ui, deps) {
  const sure = await ask(
    ui,
    "confirm",
    "Reset to defaults?",
    `mode ${DEFAULTS.mode}, threshold ${formatThreshold(DEFAULTS.thresholdCents)}, ` +
      `findings ${DEFAULTS.maxFindings}, rounds ${DEFAULTS.rounds}. Only config.json is written.`,
  );
  if (!sure) return;
  await applyReset(ui, deps);
}

async function applyReset(ui, deps) {
  let result;
  try {
    result = await deps.reset();
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.name : "unknown" };
  }
  if (!result?.ok) {
    await say(ui, deps, `could not save config.json (${result?.error ?? "unknown"})`, "error", "reset_failed");
    return;
  }
  await say(ui, deps, "reset to defaults", "info", "reset");
}

async function save(ui, deps, patch) {
  const { clean, rejected } = validatePatch(patch);
  for (const item of rejected) await say(ui, deps, `rejected ${item.key}: ${item.value}`, "warning", "rejected");
  if (Object.keys(clean).length === 0) return false;
  let result;
  try {
    result = await deps.write(clean);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.name : "unknown" };
  }
  if (!result?.ok) {
    await say(ui, deps, `could not save config.json (${result?.error ?? "unknown"})`, "error", "save_failed");
    return false;
  }
  // Only warn when the environment actually wins: an invalid variable does not override anything.
  const overridden =
    clean.mode !== undefined && deps.configuration().sources.mode === "env"
      ? " (saved, no effect while PI_CODE_HYGIENE_MODE is set)"
      : "";
  await say(ui, deps, `saved ${describe(clean)}${overridden}`, overridden ? "warning" : "info", "saved");
  return true;
}

async function runAction(parsed, ui, deps) {
  if (parsed.action === "status") {
    await say(ui, deps, detailText(deps), "info", "status");
    return;
  }
  if (parsed.action === "check") {
    const result = await deps.check();
    await say(ui, deps, checkText(result), result.ok ? "info" : "warning", result.ok ? "check" : "check_failed");
    return;
  }
  if (parsed.action === "reset") {
    if (!parsed.confirmed) {
      await say(ui, deps, "reset needs --yes, because it overwrites the current settings", "warning", "reset_needs_yes");
      return;
    }
    // --yes is the confirmation: a script or an RPC client does not have a dialog to answer.
    await applyReset(ui, deps);
    return;
  }
  await save(ui, deps, parsed.patch);
}

function statusText(deps) {
  const snapshot = deps.configuration();
  const disk = deps.diskVersion();
  const header = `pi-code-hygiene ${deps.version} | mode ${snapshot.values.mode} (${snapshot.sources.mode})`;
  const limits = `threshold ${formatThreshold(snapshot.values.thresholdCents)} | findings ${snapshot.values.maxFindings} | rounds ${snapshot.values.rounds}`;
  const stale = disk !== deps.version ? `\nSTALE: disk has ${disk}, memory has ${deps.version}. Restart Pi to load it.` : "";
  return `${header}\n${limits}${stale}`;
}

function detailText(deps) {
  const snapshot = deps.configuration();
  const check = deps.installCheck();
  const summary = deps.logSummary();
  const lines = [
    statusText(deps),
    `loaded at ${deps.loadedAt}`,
    `config: ${snapshot.exists ? "config.json" : "defaults (no config.json yet)"}`,
    `schema: ${snapshot.schema}${snapshot.schemaKnown ? "" : " (newer than this build understands)"}`,
    `install: ${check.ok ? "ok" : check.reason}${check.ok ? "" : ` — ${HELP[check.reason] ?? "see the README"}`}`,
    `log: ${summary.size} bytes, ${summary.total} records in the tail, last ${summary.last ?? "none"}`,
  ];
  if (snapshot.rawMode !== null && snapshot.rawMode !== snapshot.values.mode) {
    lines.push(`mode as written: ${snapshot.rawMode}`);
  }
  if (snapshot.legacy && snapshot.configMode && snapshot.legacy !== snapshot.configMode) {
    lines.push(`legacy mode file says ${snapshot.legacy}, config.json says ${snapshot.configMode}; config.json wins`);
  }
  return lines.join("\n");
}

function logText(deps) {
  const summary = deps.logSummary();
  if (summary.total === 0) return "log: empty";
  const outcomes = Object.entries(summary.outcomes)
    .map(([key, count]) => `${key} ${count}`)
    .join(", ");
  const tail = summary.tail.slice(-TAIL_LINES).map((record) => {
    const parts = [record.ts, record.outcome ?? "record"];
    if (record.mode) parts.push(record.mode);
    if (record.tool) parts.push(record.tool);
    if (typeof record.run_ms === "number") parts.push(`${record.run_ms}ms`);
    return parts.join(" ");
  });
  return [`log: ${summary.size} bytes, ${summary.total} records in the tail`, outcomes, ...tail].join("\n");
}

// Dialogs go through one place: a timeout resolves as "no answer", which every caller treats as
// "change nothing".
async function ask(ui, kind, title, body) {
  // No UI means no dialog: cancelling is the only safe answer, and the caller changes nothing.
  if (!ui) return kind === "select" ? undefined : false;
  const call = kind === "select" ? ui.select(title, body) : ui.confirm(title, body);
  const answer = await withTimeout(call, dialogTimeoutMs);
  return kind === "select" ? answer : answer === true;
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise.catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

// With a UI the answer is a notification; without one it goes to the log, because writing to
// standard output would break the JSON stream.
function describe(clean) {
  return Object.entries(clean)
    .map(([key, value]) => (key === "thresholdCents" ? `threshold ${formatThreshold(value)}` : `${key} ${value}`))
    .join(", ");
}

function firstWord(text) {
  return String(text).trim().split(/\s+/)[0];
}

// With a UI the answer is a notification; without one it goes to the log, because writing to
// standard output would break the JSON stream. The log keeps the verdict and the reason, never the
// whole text: a stderr tail can carry paths and code, and the log is meant to hold neither.
async function say(ui, deps, text, level, reason = "message") {
  if (ui) {
    ui.notify(text, level);
    return;
  }
  deps.logWrite({ outcome: "command", ok: level !== "error", reason });
}
