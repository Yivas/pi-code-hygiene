// The `/hygiene` command: a menu for the interactive modes, and one action per argument for
// scripts and for runs without a UI.
//
// Everything the command reads comes from the dependencies handed over by index.js, so it needs no
// imports from the host beyond the dialogs and can be tested with a plain object.
//
// The menu is a list of strings, because that is what `ctx.ui.select` takes. Each entry is rendered
// as a label followed by a description in a second column, padded with spaces, and the chosen
// string is mapped back to its action through a Map built at the same time: the text is never
// parsed. Only ASCII goes in, and lines are kept within the width the terminal reports.

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

// Room for the host's own cursor and frame around the list.
const WIDTH_MARGIN = 8;
const MIN_WIDTH = 40;
const MAX_WIDTH = 78;
// Below this, a second column cannot hold anything worth reading: one column with a hyphen wins.
const MIN_TWO_COLUMNS = 44;
const MAX_LABEL = 22;

// Overridable only so a test does not have to wait five minutes for a dialog nobody answers.
let dialogTimeoutMs = DIALOG_TIMEOUT_MS;

const BACK = { key: "back", label: "Back", desc: "return without changing anything" };
const EXIT = { key: "exit", label: "Exit", desc: "close the menu" };

const MODE_DESC = {
  shadow: "record counts only, change nothing",
  on: "append a short note after an edit",
  fix: "ask for fixes in code just written",
  off: "do nothing at all",
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

// The width to lay the list out for. A terminal reports its columns; anywhere else a modest fixed
// width keeps the two columns readable as plain text, which is what an RPC client sees.
export function menuWidth(stdout = process.stdout) {
  // A pseudo-terminal may report isTTY with no usable width, so the number itself is checked.
  const columns = Number(stdout?.columns);
  const known = stdout?.isTTY === true && Number.isFinite(columns) && columns > 0;
  // Without a terminal there is no width to respect: 80 columns as a text file would show it.
  const raw = known ? columns : 80;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw - WIDTH_MARGIN));
}

// Turns entries into the strings the dialog shows, and remembers which action each string means.
// Two entries that would render the same string are told apart with a suffix, so the map never
// loses an action; an empty description simply has no second column. Text from outside is flattened
// to one line first: a newline in a reason would split an entry and lose its action.
export function formatMenu(entries, width = menuWidth()) {
  const labels = entries.map((entry) => oneLine(entry.label));
  const column = Math.min(MAX_LABEL, Math.max(...labels.map((label) => widthOf(label))));
  const twoColumns = width >= MIN_TWO_COLUMNS && entries.some((entry) => entry.desc);
  const lines = [];
  const byLine = new Map();

  entries.forEach((entry, index) => {
    const label = labels[index];
    const desc = entry.desc === undefined ? "" : oneLine(entry.desc);
    const line = twoColumns ? `${pad(label, column)}  ${desc}` : desc ? `${label} - ${desc}` : label;
    let unique = truncate(line, width);
    for (let n = 2; byLine.has(unique); n++) unique = truncate(`${line} (${n})`, width);
    lines.push(unique);
    byLine.set(unique, entry.key);
  });
  return { lines, byLine };
}

// One line, no control characters, no runs of spaces: what the dialog can show without surprises.
function oneLine(text) {
  let flat = "";
  for (const char of String(text ?? "")) {
    flat += char.codePointAt(0) < 0x20 || char.codePointAt(0) === 0x7f ? " " : char;
  }
  return flat.replace(/\s+/g, " ").trim();
}

function widthOf(text) {
  return [...text].length;
}

// The title is not laid out by `formatMenu`, so it is wrapped here: a status line wider than the
// terminal is the host's to cut, and it looks broken.
export function wrapLines(text, width) {
  const lines = [];
  for (const line of String(text).split("\n")) {
    let current = "";
    for (const word of line.split(" ")) {
      if (!current) current = word;
      else if (widthOf(current) + 1 + widthOf(word) <= width) current += ` ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines.join("\n");
}

function pad(text, width) {
  const room = width - widthOf(text);
  return room <= 0 ? text : text + " ".repeat(room);
}

// Ends in three dots rather than an ellipsis: a legacy Windows console shows one and not the other.
function truncate(text, width) {
  const chars = [...text];
  if (chars.length <= width) return text.trimEnd();
  return `${chars.slice(0, Math.max(0, width - 3)).join("").trimEnd()}...`;
}

// Asks one list question and returns the key of what was chosen, or undefined when the dialog was
// cancelled, timed out or answered with something this menu did not offer.
async function choose(ui, title, entries) {
  const { lines, byLine } = formatMenu(entries);
  const answer = await ask(ui, "select", title, lines);
  if (answer === undefined) return { key: undefined };
  const text = String(answer);
  const key = byLine.get(text) ?? byLine.get(text.trimEnd()) ?? byLine.get(oneLine(text));
  // An answer the menu did not offer is not a cancel: say so and leave the state alone.
  return { key, unknown: key === undefined };
}

// The reason codes are for the log; the menu says what to do about them.
function readableReason(reason) {
  return HELP[reason] ?? "needs attention: see Installation";
}

function mainEntries(deps) {
  const snapshot = deps.configuration();
  const installed = deps.installCheck();
  const disk = deps.diskVersion();
  return [
    { key: "mode", label: `Mode: ${snapshot.values.mode}`, desc: MODE_DESC[snapshot.values.mode] ?? "" },
    {
      key: "limits",
      label: "Threshold and notes",
      desc: `${formatThreshold(snapshot.values.thresholdCents)}, ${snapshot.values.maxFindings}/note, ${snapshot.values.rounds} rounds`,
    },
    {
      key: "status",
      label: "Status and diagnostics",
      desc: disk === deps.version ? "version, install, log" : `restart Pi, disk has ${disk}`,
    },
    { key: "log", label: "Log", desc: "what was recorded last" },
    {
      key: "install",
      label: "Installation",
      desc: installed.ok ? "paths and a live check" : readableReason(installed.reason),
    },
    { key: "reset", label: "Reset to defaults", desc: "back to the built-in values" },
    EXIT,
  ];
}

async function openMenu(ui, deps) {
  if (!ui) {
    // No dialogs here: the log gets the reason, not the text, and that is the whole trace a host
    // without a UI gets. Pi does not dispatch commands in -p, so this is a defensive path.
    await say(ui, deps, statusText(deps), "info", "status");
    return;
  }
  let unknownAnswers = 0;
  const width = menuWidth();
  for (;;) {
    const { key, unknown } = await choose(ui, wrapLines(statusText(deps), width), mainEntries(deps));
    if (unknown) {
      // Not a cancel: an answer the menu never offered is worth saying out loud. A host that keeps
      // answering with something else must not spin forever, so three of those close the menu.
      unknownAnswers++;
      if (unknownAnswers >= 3) {
        await say(ui, deps, "the answers do not match this menu; closing it", "warning", "unknown_choice");
        return;
      }
      await say(ui, deps, "that answer is not one of the menu entries", "warning", "unknown_choice");
      continue;
    }
    if (key === undefined || key === "exit") return;
    // A valid choice clears the count: three stray answers spread over a session are not a loop.
    unknownAnswers = 0;
    await runMenuItem(key, ui, deps);
  }
}

async function runMenuItem(key, ui, deps) {
  if (key === "status") await say(ui, deps, detailText(deps), "info", "status");
  else if (key === "mode") await chooseMode(ui, deps);
  else if (key === "limits") await chooseLimits(ui, deps);
  else if (key === "install") await showInstall(ui, deps);
  else if (key === "log") await say(ui, deps, logText(deps), "info", "log");
  else if (key === "reset") await resetToDefaults(ui, deps);
}

async function chooseMode(ui, deps) {
  const current = deps.configuration().values.mode;
  const entries = MODES.map((mode) => ({
    key: mode,
    // The asterisk stays in the label, where truncation never reaches it.
    label: mode === current ? `${mode} *` : mode,
    desc: MODE_DESC[mode],
  }));
  const { key } = await choose(ui, "Mode: what happens after every edit (* is current)", entries.concat(BACK));
  if (!key || key === "back") return;
  await save(ui, deps, { mode: key });
}

async function chooseLimits(ui, deps) {
  for (;;) {
    const snapshot = deps.configuration();
    const entries = [
      {
        key: "threshold",
        label: `Threshold: ${formatThreshold(snapshot.values.thresholdCents)}`,
        desc: "what codehygiene reports",
      },
      { key: "findings", label: `Findings per note: ${snapshot.values.maxFindings}`, desc: "in on and fix" },
      { key: "rounds", label: `Fix rounds: ${snapshot.values.rounds}`, desc: "per file, in fix mode" },
      BACK,
    ];
    const { key } = await choose(ui, "Threshold and notes", entries);
    if (!key || key === "back") return;
    if (key === "threshold") await chooseThreshold(ui, deps);
    else if (key === "findings") await chooseFindings(ui, deps);
    else await chooseRounds(ui, deps);
  }
}

const THRESHOLD_DESC = {
  40: "many notes",
  45: "many notes",
  50: "more than the default",
  55: "the default and the measured one",
  60: "fewer notes",
  65: "fewer notes",
  70: "only the clearer ones",
  75: "only the clearer ones",
  80: "only the clearest",
  85: "only the clearest",
  90: "only the clearest",
};

async function chooseThreshold(ui, deps) {
  const current = deps.configuration().values.thresholdCents;
  const entries = THRESHOLD_CENTS.map((cents) => ({
    key: String(cents),
    label: cents === current ? `${formatThreshold(cents)} *` : formatThreshold(cents),
    desc: THRESHOLD_DESC[cents] ?? "",
  }));
  // A value typed into the file is not in the list: it has no entry to mark, so the title says it.
  const listed = THRESHOLD_CENTS.includes(current);
  const title = `Threshold passed to codehygiene (* is current${listed ? "" : `, now ${formatThreshold(current)}`})`;
  const { key } = await choose(ui, title, entries.concat(BACK));
  if (!key || key === "back") return;
  await save(ui, deps, { thresholdCents: key });
}

const FINDINGS_DESC = { 1: "the shortest note", 2: "a middle size", 3: "up to three, the default" };

async function chooseFindings(ui, deps) {
  const current = deps.configuration().values.maxFindings;
  const entries = MAX_FINDINGS.map((value) => ({
    key: String(value),
    label: value === current ? `${value} *` : String(value),
    desc: FINDINGS_DESC[value] ?? "",
  }));
  const { key } = await choose(ui, "Findings per note (* is current)", entries.concat(BACK));
  if (!key || key === "back") return;
  await save(ui, deps, { maxFindings: key });
}

const ROUNDS_DESC = {
  1: "one note, then quiet",
  2: "a note and a re-check, the default",
  3: "insistent",
  4: "very insistent",
};

async function chooseRounds(ui, deps) {
  const current = deps.configuration().values.rounds;
  const entries = ROUNDS.map((value) => ({
    key: String(value),
    label: value === current ? `${value} *` : String(value),
    desc: ROUNDS_DESC[value] ?? "",
  }));
  const { key } = await choose(ui, "Rounds per file in fix mode (* is current)", entries.concat(BACK));
  if (!key || key === "back") return;
  await save(ui, deps, { rounds: key });
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
    `install: ${check.ok ? "ok" : check.reason}${check.ok ? "" : ` - ${HELP[check.reason] ?? "see the README"}`}`,
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

function describe(clean) {
  return Object.entries(clean)
    .map(([key, value]) => (key === "thresholdCents" ? `threshold ${formatThreshold(value)}` : `${key} ${value}`))
    .join(", ");
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
