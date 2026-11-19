// The `/hygiene` command: a menu for the interactive modes, and one action per argument for
// scripts and for runs without a UI.
//
// Everything the command reads comes from the dependencies handed over by index.js, so it needs no
// imports from the host and can be tested with a plain object.
//
// Two ways to show the menu, one model of entries behind both:
//   - in the terminal UI, a small component of our own: the row under the cursor carries its
//     description on the same line, the others carry none, and escape closes or goes back. The
//     dialog API of the host cannot do that, because it takes plain strings and never says which
//     row is highlighted.
//   - anywhere else (RPC), `ctx.ui.select` with the same entries, each one as a line with its
//     description, and a last row to close or go back, because a client may have no other way out.
// The chosen option always resolves through a key, never by parsing the text.

import {
  DEFAULTS,
  formatThreshold,
  MAX_FINDINGS,
  MODES,
  ROUNDS,
  THRESHOLD_CENTS,
  validatePatch,
} from "./config.js";
import { clampIndex, HINTS, oneLine, reduceMenu, renderMenu, truncate, widthOf } from "./menu.js";

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

// Only for the paths that cannot press escape: the terminal UI has no row for this.
const CLOSE = { key: "close", label: "Close", desc: "close the menu" };
const BACK = { key: "back", label: "Back", desc: "return without changing anything" };

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
        await openMenu(ctx, deps);
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
  const columns = Number(stdout?.columns);
  const known = stdout?.isTTY === true && Number.isFinite(columns) && columns > 0;
  const raw = known ? columns : 80;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, raw - WIDTH_MARGIN));
}

// Turns entries into the strings `select` shows, and remembers which action each string means.
// Used only where there is no terminal to draw a cursor on.
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

function pad(text, width) {
  const room = width - widthOf(text);
  return room <= 0 ? text : text + " ".repeat(room);
}

// One question, one answer, and the key of what was chosen. Cancelling, timing out and an answer
// the menu never offered all end here without touching anything.
async function choose(ctx, { statusLines, items, selected = 0, back = false }) {
  const ui = ctx?.ui;
  if (ctx?.mode === "tui" && ui) {
    const picked = await pickInTerminal(ctx, { statusLines, items, selected, back });
    return picked === undefined ? { cancelled: true } : { key: picked };
  }
  const entries = back ? items.concat(BACK) : items.concat(CLOSE);
  const { lines, byLine } = formatMenu(entries);
  const answer = await ask(ui, "select", statusLines.join("\n"), lines);
  if (answer === undefined) return { cancelled: true };
  const text = String(answer);
  const key = byLine.get(text) ?? byLine.get(text.trimEnd()) ?? byLine.get(oneLine(text));
  if (key === undefined) return { unknown: true };
  if (key === "close" || key === "back") return { cancelled: true };
  return { key };
}

// The terminal UI: our own component, so the description can follow the cursor and escape can close
// the menu without a row for it. `custom` only exists in the terminal UI, which is why the caller
// checks the mode first.
async function pickInTerminal(ctx, { statusLines, items, selected, back }) {
  const hint = back ? HINTS.submenu : HINTS.main;
  const value = await ctx.ui.custom(
    (tui, theme, keybindings, done) => {
      let state = { selected: clampIndex(selected, items.length) };
      const paint = (line, index) => {
        if (line.startsWith("> ")) return theme.fg("accent", line);
        if (index === linesForWidth.cache.length - 1) return theme.fg("dim", line);
        return line;
      };
      // The lines are rebuilt for every width the host asks for, and painted on the way out.
      const linesForWidth = { width: 0, cache: [] };
      const build = (width) => {
        if (linesForWidth.width !== width) {
          linesForWidth.width = width;
          linesForWidth.cache = renderMenu({ header: statusLines, items, selected: state.selected, hint }, width);
        }
        return linesForWidth.cache;
      };
      return {
        render(width) {
          // The lines are already cut to the width; painting wraps them in escape codes, so it
          // comes last.
          return build(width).map((line, index) => paint(line, index));
        },
        handleInput(data) {
          if (keybindings.matches(data, "tui.select.up")) state = reduceMenu(state, "up", items.length);
          else if (keybindings.matches(data, "tui.select.down")) state = reduceMenu(state, "down", items.length);
          else if (keybindings.matches(data, "tui.select.confirm")) return done(items[state.selected].key);
          else if (keybindings.matches(data, "tui.select.cancel")) return done(undefined);
          else return;
          linesForWidth.width = 0;
          tui.requestRender();
          return undefined;
        },
        invalidate() {
          linesForWidth.width = 0;
        },
      };
    },
    { blocked: { kind: "question", message: "pi-code-hygiene settings" } },
  );
  return typeof value === "string" ? value : undefined;
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
  ];
}

async function openMenu(ctx, deps) {
  if (!ctx?.hasUI) {
    // No dialogs here: the log gets the reason, not the text, and that is the whole trace a host
    // without a UI gets. Pi does not dispatch commands in -p, so this is a defensive path.
    await say(undefined, deps, statusText(deps), "info", "status");
    return;
  }
  const width = menuWidth();
  let selected = 0;
  let unknownAnswers = 0;
  for (;;) {
    const items = mainEntries(deps);
    const statusLines = wrapLines(statusText(deps), width).split("\n");
    const result = await choose(ctx, { statusLines, items, selected });
    if (result.unknown) {
      // Not a cancel: an answer the menu never offered is worth saying out loud. A host that keeps
      // answering with something else must not spin forever, so three of those close the menu.
      unknownAnswers++;
      if (unknownAnswers >= 3) {
        await say(ctx.ui, deps, "the answers do not match this menu; closing it", "warning", "unknown_choice");
        return;
      }
      await say(ctx.ui, deps, "that answer is not one of the menu entries", "warning", "unknown_choice");
      continue;
    }
    if (result.cancelled || result.key === undefined) return;
    // A valid choice clears the count: three stray answers spread over a session are not a loop.
    unknownAnswers = 0;
    selected = Math.max(0, items.findIndex((item) => item.key === result.key));
    await runMenuItem(result.key, ctx, deps);
  }
}

async function runMenuItem(key, ctx, deps) {
  if (key === "status") await say(ctx.ui, deps, detailText(deps), "info", "status");
  else if (key === "mode") await chooseMode(ctx, deps);
  else if (key === "limits") await chooseLimits(ctx, deps);
  else if (key === "install") await showInstall(ctx.ui, deps);
  else if (key === "log") await say(ctx.ui, deps, logText(deps), "info", "log");
  else if (key === "reset") await resetToDefaults(ctx.ui, deps);
}

async function chooseMode(ctx, deps) {
  const current = deps.configuration().values.mode;
  const items = MODES.map((mode) => ({
    key: mode,
    // The asterisk stays in the label, where truncation never reaches it.
    label: mode === current ? `${mode} *` : mode,
    desc: MODE_DESC[mode],
  }));
  const result = await choose(ctx, {
    statusLines: ["Mode: what happens after every edit", "(*) marks the value in use"],
    items,
    selected: Math.max(0, MODES.indexOf(current)),
    back: true,
  });
  if (result.cancelled || !result.key) return;
  await save(ctx.ui, deps, { mode: result.key });
}

async function chooseLimits(ctx, deps) {
  for (;;) {
    const snapshot = deps.configuration();
    const items = [
      {
        key: "threshold",
        label: `Threshold: ${formatThreshold(snapshot.values.thresholdCents)}`,
        desc: "what codehygiene reports",
      },
      { key: "findings", label: `Findings per note: ${snapshot.values.maxFindings}`, desc: "in on and fix" },
      { key: "rounds", label: `Fix rounds: ${snapshot.values.rounds}`, desc: "per file, in fix mode" },
    ];
    const result = await choose(ctx, { statusLines: ["Threshold and notes"], items, back: true });
    if (result.cancelled || !result.key) return;
    if (result.key === "threshold") await chooseThreshold(ctx, deps);
    else if (result.key === "findings") await chooseFindings(ctx, deps);
    else await chooseRounds(ctx, deps);
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

async function chooseThreshold(ctx, deps) {
  const current = deps.configuration().values.thresholdCents;
  const items = THRESHOLD_CENTS.map((cents) => ({
    key: String(cents),
    label: cents === current ? `${formatThreshold(cents)} *` : formatThreshold(cents),
    desc: THRESHOLD_DESC[cents] ?? "",
  }));
  // A value typed into the file is not in the list: it has no entry to mark, so the header says it.
  const listed = THRESHOLD_CENTS.includes(current);
  const statusLines = [
    "Threshold passed to codehygiene",
    listed ? "(*) marks the value in use" : `(*) marks the value in use, now ${formatThreshold(current)}`,
  ];
  const result = await choose(ctx, {
    statusLines,
    items,
    selected: Math.max(0, THRESHOLD_CENTS.indexOf(current)),
    back: true,
  });
  if (result.cancelled || !result.key) return;
  await save(ctx.ui, deps, { thresholdCents: result.key });
}

const FINDINGS_DESC = { 1: "the shortest note", 2: "a middle size", 3: "up to three, the default" };

async function chooseFindings(ctx, deps) {
  const current = deps.configuration().values.maxFindings;
  const items = MAX_FINDINGS.map((value) => ({
    key: String(value),
    label: value === current ? `${value} *` : String(value),
    desc: FINDINGS_DESC[value] ?? "",
  }));
  const result = await choose(ctx, {
    statusLines: ["Findings per note", "(*) marks the value in use"],
    items,
    selected: Math.max(0, MAX_FINDINGS.indexOf(current)),
    back: true,
  });
  if (result.cancelled || !result.key) return;
  await save(ctx.ui, deps, { maxFindings: result.key });
}

const ROUNDS_DESC = {
  1: "one note, then quiet",
  2: "a note and a re-check, the default",
  3: "insistent",
  4: "very insistent",
};

async function chooseRounds(ctx, deps) {
  const current = deps.configuration().values.rounds;
  const items = ROUNDS.map((value) => ({
    key: String(value),
    label: value === current ? `${value} *` : String(value),
    desc: ROUNDS_DESC[value] ?? "",
  }));
  const result = await choose(ctx, {
    statusLines: ["Rounds per file in fix mode", "(*) marks the value in use"],
    items,
    selected: Math.max(0, ROUNDS.indexOf(current)),
    back: true,
  });
  if (result.cancelled || !result.key) return;
  await save(ctx.ui, deps, { rounds: result.key });
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

// The title is not laid out by `renderMenu` in the terminal path or by `formatMenu` otherwise, so a
// status line wider than the available width is wrapped here.
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
