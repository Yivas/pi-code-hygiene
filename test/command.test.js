import assert from "node:assert/strict";
import test from "node:test";
import { createCommand, formatMenu, menuWidth, wrapLines } from "../src/command.js";
import { DEFAULTS } from "../src/config.js";
import { setup } from "./helpers.js";

// A deps object that behaves like the one index.js builds, without touching a real install.
function fakeDeps(overrides = {}) {
  const writes = [];
  const logs = [];
  const deps = {
    version: "0.3.0",
    loadedAt: "2026-11-18T05:00:00.000Z",
    dialogTimeoutMs: 30,
    runtime: () => ({ home: "C:/home", python: "C:/home/python.exe", packageDir: "C:/home/src/codehygiene", log: {} }),
    configuration: () => ({
      values: { ...DEFAULTS },
      sources: { mode: "default", thresholdCents: "default", maxFindings: "default", rounds: "default" },
      rejected: [],
      problems: [],
      schema: 1,
      schemaKnown: true,
      rawMode: null,
      legacy: undefined,
      configMode: undefined,
      exists: false,
    }),
    diskVersion: () => "0.3.0",
    installCheck: () => ({ ok: true, reason: "" }),
    check: async () => ({ ok: true, ms: 350, findings: 2, score: 0.8 }),
    write: async (patch) => {
      writes.push(patch);
      return { ok: true };
    },
    reset: async () => {
      writes.push({ reset: true });
      return { ok: true };
    },
    logSummary: () => ({ size: 120, total: 3, last: "2026-11-18T05:00:00.000Z", outcomes: { ok: 2, session: 1 }, tail: [] }),
    logWrite: (record) => logs.push(record),
    logPath: () => "C:/home/state/shadow.jsonl",
    ...overrides,
  };
  return { deps, writes, logs };
}

// Scripted dialogs. Each answer is matched against the rendered lines by the prefix of its first
// column, the way a person picks an entry: `Mode`, `on`, `Threshold`, `Reset to defaults`. An answer
// that matches nothing is delivered as if the dialog had been cancelled, which also gives the
// "unknown choice" case for free.
function ui(answers = [], { notes, calls } = {}) {
  const queue = [...answers];
  const match = (lines, wanted) =>
    lines.find((line) => line === wanted || (line.startsWith(wanted) && line[wanted.length] === " "));
  return {
    hasUI: true,
    ui: {
      select: async (title, lines) => {
        calls?.push({ title, lines });
        if (queue.length === 0) return undefined;
        const wanted = queue.shift();
        if (wanted === undefined) return undefined;
        // An object with `raw` answers with something the menu never offered.
        if (typeof wanted === "object") return wanted.raw;
        return match(lines, String(wanted));
      },
      confirm: async () => (queue.length > 0 ? queue.shift() : false),
      input: async () => (queue.length > 0 ? queue.shift() : undefined),
      notify: (text, level) => notes?.push({ text, level }),
    },
  };
}

test("the status line says what runs, from where and whether the disk disagrees", async () => {
  const notes = [];
  const { deps } = fakeDeps({ diskVersion: () => "0.2.1" });
  const command = createCommand(deps);
  await command.handler("status", ui([], { notes }));
  const text = notes[0].text;
  assert.match(text, /pi-code-hygiene 0\.3\.0/);
  assert.match(text, /mode shadow/);
  assert.match(text, /STALE: disk has 0\.2\.1/);
  assert.match(text, /Restart Pi/);
});

test("without a UI nothing is shown and the outcome goes to the log", async () => {
  const { deps, logs } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("status", { hasUI: false });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].outcome, "command");
  assert.equal(logs[0].reason, "status");
  assert.equal(logs[0].ok, true);
  // The log keeps a reason, not the sentence: it can carry paths and code.
  assert.equal(logs[0].text, undefined);
});

test("a mode given as an argument is validated and saved", async () => {
  const notes = [];
  const { deps, writes } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("mode FIX", ui([], { notes }));
  assert.deepEqual(writes, [{ mode: "fix" }]);
  assert.match(notes[0].text, /saved mode fix/);
});

test("an impossible value is rejected with its name and nothing is written", async () => {
  const notes = [];
  const { deps, writes } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("mode loud", ui([], { notes }));
  assert.deepEqual(writes, []);
  assert.match(notes[0].text, /rejected mode: loud/);
  assert.equal(notes[0].level, "warning");
});

test("set understands the three numbers and refuses the rest", async () => {
  const notes = [];
  const { deps, writes } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("set threshold 0.65", ui([], { notes }));
  await command.handler("set rounds 5", ui([], { notes }));
  assert.deepEqual(writes, [{ thresholdCents: 65 }]);
  assert.match(notes[1].text, /rejected rounds: 5/);
});

test("an unknown argument explains the usage instead of guessing", async () => {
  const notes = [];
  const { deps } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("frobnicate", ui([], { notes }));
  assert.match(notes[0].text, /usage: \/hygiene/);
});

test("with the environment in charge, saving the mode says it will not apply", async () => {
  const notes = [];
  const { deps, writes } = fakeDeps({
    configuration: () => ({
      values: { ...DEFAULTS, mode: "on" },
      sources: { mode: "env", thresholdCents: "default", maxFindings: "default", rounds: "default" },
      rejected: [],
      problems: [],
      schema: 1,
      schemaKnown: true,
      rawMode: "on",
      legacy: undefined,
      configMode: undefined,
      exists: false,
    }),
  });
  const command = createCommand(deps);
  const saved = process.env.PI_CODE_HYGIENE_MODE;
  process.env.PI_CODE_HYGIENE_MODE = "on";
  try {
    await command.handler("mode fix", ui([], { notes }));
  } finally {
    if (saved === undefined) delete process.env.PI_CODE_HYGIENE_MODE;
    else process.env.PI_CODE_HYGIENE_MODE = saved;
  }
  assert.deepEqual(writes, [{ mode: "fix" }]);
  assert.equal(notes[0].level, "warning");
  assert.match(notes[0].text, /no effect while PI_CODE_HYGIENE_MODE is set/);
});

test("the menu writes what was chosen and exits when asked", async () => {
  const notes = [];
  const { deps, writes } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("", ui(["Mode:", "fix", "Exit"], { notes }));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes, [{ mode: "fix" }]);
});

test("closing the menu writes nothing", async () => {
  const { deps, writes } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("", ui([]));
  assert.deepEqual(writes, []);
});

test("the threshold submenu saves the value that was picked", async () => {
  const { deps, writes } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("", ui(["Threshold and notes", "Threshold:", "0.65", "Back", "Exit"]));
  assert.deepEqual(writes, [{ thresholdCents: 65 }]);
});

test("reset asks first and refuses without --yes", async () => {
  const notes = [];
  const { deps, writes } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("reset", ui([], { notes }));
  assert.deepEqual(writes, []);
  assert.match(notes[0].text, /reset needs --yes/);

  // --yes is the confirmation: it does not open a dialog, which an RPC client would have to answer.
  const noDialogs = {
    hasUI: true,
    ui: {
      select: () => {
        throw new Error("select must not be called");
      },
      confirm: () => {
        throw new Error("confirm must not be called");
      },
      notify: (text, level) => notes.push({ text, level }),
    },
  };
  await command.handler("reset --yes", noDialogs);
  assert.deepEqual(writes, [{ reset: true }]);
  assert.match(notes.at(-1).text, /reset to defaults/);
});

test("reset --yes works with no UI at all and records the action", async () => {
  const { deps, writes, logs } = fakeDeps();
  await createCommand(deps).handler("reset --yes", { hasUI: false });
  assert.deepEqual(writes, [{ reset: true }]);
  assert.equal(logs.at(-1).reason, "reset");
});

test("reset from the menu does nothing when the confirmation is declined", async () => {
  const { deps, writes } = fakeDeps();
  const command = createCommand(deps);
  await command.handler("", ui(["Reset to defaults", false, "Exit"]));
  assert.deepEqual(writes, []);
});

test("a context with hasUI but no dialogs does not throw", async () => {
  const { deps, writes } = fakeDeps();
  await createCommand(deps).handler("reset --yes", { hasUI: true });
  assert.deepEqual(writes, [{ reset: true }]);
});

test("a dialog nobody answers is treated as no answer", async () => {
  const { deps, writes } = fakeDeps({ dialogTimeoutMs: 10 });
  const command = createCommand(deps);
  const silent = { hasUI: true, ui: { select: () => new Promise(() => {}), confirm: () => new Promise(() => {}), notify: () => {} } };
  await command.handler("", silent);
  assert.deepEqual(writes, []);
});

test("a broken install is shown with the reason and what fixes it", async () => {
  const notes = [];
  const { deps } = fakeDeps({ installCheck: () => ({ ok: false, reason: "manifest_missing" }) });
  const command = createCommand(deps);
  await command.handler("status", ui([], { notes }));
  assert.match(notes[0].text, /install: manifest_missing - regenerate manifest\.sha256/);
});

test("check reports success and failure in plain words", async () => {
  const notes = [];
  const ok = fakeDeps();
  await createCommand(ok.deps).handler("check", ui([], { notes }));
  assert.match(notes[0].text, /ran in 350 ms, score 0\.8, 2 findings/);

  const bad = fakeDeps({ check: async () => ({ ok: false, outcome: "error", exit: 1, stderr: "traceback" }) });
  await createCommand(bad.deps).handler("check", ui([], { notes }));
  assert.match(notes[1].text, /check failed: error/);
  assert.match(notes[1].text, /traceback/);
});

test("the log view lists the counts and the last lines", async () => {
  const notes = [];
  const { deps } = fakeDeps({
    logSummary: () => ({
      size: 2048,
      total: 3,
      last: "2026-11-18T05:00:00.000Z",
      outcomes: { ok: 2, session: 1 },
      tail: [{ ts: "2026-11-18T05:00:00.000Z", outcome: "ok", mode: "on", tool: "edit", run_ms: 400 }],
    }),
  });
  await createCommand(deps).handler("", ui(["Log", "Exit"], { notes }));
  assert.match(notes[0].text, /2048 bytes, 3 records/);
  assert.match(notes[0].text, /ok 2, session 1/);
  assert.match(notes[0].text, /400ms/);
});

test("the menu keeps a second column and every line inside the width", () => {
  const entries = [
    { key: "a", label: "Mode: shadow", desc: "record counts only, change nothing" },
    { key: "b", label: "Threshold and notes", desc: "0.55, 3/note, 2 rounds" },
    { key: "c", label: "Exit", desc: "close the menu" },
  ];
  for (const width of [40, 44, 60, 78, 120]) {
    const { lines, byLine } = formatMenu(entries, width);
    assert.equal(lines.length, entries.length);
    for (const line of lines) {
      assert.ok(line.length <= width, `${line} fits ${width}`);
      assert.ok(!line.includes("\t") && !line.includes("\n") && !line.includes("\u001b"));
      assert.equal(line, line.trimEnd());
    }
    for (const entry of entries) {
      assert.ok(lines.some((line) => byLine.get(line) === entry.key), `an action is reachable at ${width}`);
    }
  }
});

test("with room, every description starts at the same column", () => {
  const entries = [
    { key: "a", label: "Exit", desc: "close" },
    { key: "b", label: "Threshold and notes", desc: "0.55" },
  ];
  const { lines } = formatMenu(entries, 78);
  const starts = lines.map((line) => line.search(/ {2}\S/));
  assert.equal(new Set(starts).size, 1);
});

test("a narrow terminal collapses the second column into one line", () => {
  const { lines } = formatMenu([{ key: "x", label: "Threshold and notes", desc: "0.55" }], 40);
  assert.equal(lines[0], "Threshold and notes - 0.55");
});

test("a status line wider than the terminal is wrapped, not left to the host", () => {
  const header = "pi-code-hygiene 0.3.0 | mode shadow (default) | threshold 0.55 | findings 3";
  const wrapped = wrapLines(header, 40).split("\n");
  assert.ok(wrapped.length > 1);
  for (const line of wrapped) assert.ok(line.length <= 40, line);
  assert.equal(wrapped.join(" "), header);
});

test("a description that does not fit ends in three dots", () => {
  const { lines } = formatMenu([{ key: "x", label: "Exit", desc: "a".repeat(200) }], 40);
  assert.ok(lines[0].length <= 40);
  assert.ok(lines[0].startsWith("Exit"));
  assert.ok(lines[0].endsWith("..."));
});

test("two entries that would render the same keep different actions", () => {
  const { lines, byLine } = formatMenu(
    [
      { key: "one", label: "Same", desc: "" },
      { key: "two", label: "Same", desc: "" },
    ],
    64,
  );
  assert.notEqual(lines[0], lines[1]);
  assert.equal(byLine.get(lines[0]), "one");
  assert.equal(byLine.get(lines[1]), "two");
});

test("the menu width follows the terminal and stays in a sane range", () => {
  assert.equal(menuWidth({ isTTY: true, columns: 40 }), 40);
  assert.equal(menuWidth({ isTTY: true, columns: 60 }), 52);
  assert.equal(menuWidth({ isTTY: true, columns: 200 }), 78);
  assert.equal(menuWidth({ isTTY: false }), 72);
  // A pseudo-terminal may say isTTY without a usable width.
  assert.equal(menuWidth({ isTTY: true, columns: undefined }), 72);
  assert.equal(menuWidth({ isTTY: true, columns: 0 }), 72);
});

test("text from outside is flattened so an entry stays one line", () => {
  const { lines, byLine } = formatMenu(
    [{ key: "install", label: "Installation", desc: "first line\nsecond\u001b[31m line" }],
    72,
  );
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes("\n") && !lines[0].includes("\u001b"));
  assert.equal(byLine.get(lines[0]), "install");
});

test("no two entries render the same line, at any width", () => {
  const entries = [
    { key: "a", label: "Status and diagnostics", desc: "version, install, log" },
    { key: "b", label: "Status and diagnostics 2", desc: "version, install, log" },
    { key: "c", label: "Installation", desc: "python missing: create the venv" },
    { key: "d", label: "Exit", desc: "close the menu" },
  ];
  for (let width = 40; width <= 78; width++) {
    const { lines } = formatMenu(entries, width);
    assert.equal(new Set(lines).size, lines.length, `unique at ${width}`);
  }
});

test("a truncated line still resolves to its own action", () => {
  const { lines, byLine } = formatMenu(
    [
      { key: "long", label: "Threshold and notes", desc: "a".repeat(200) },
      { key: "exit", label: "Exit", desc: "close the menu" },
    ],
    40,
  );
  assert.ok(lines[0].endsWith("..."));
  assert.equal(byLine.get(lines[0]), "long");
});

test("the current value is marked in the label, where truncation cannot eat it", async () => {
  const calls = [];
  const { deps } = fakeDeps({
    configuration: () => ({
      values: { ...DEFAULTS, mode: "fix" },
      sources: { mode: "config", thresholdCents: "default", maxFindings: "default", rounds: "default" },
      rejected: [],
      problems: [],
      schema: 1,
      schemaKnown: true,
      rawMode: "fix",
      legacy: undefined,
      configMode: "fix",
      exists: true,
    }),
  });
  await createCommand(deps).handler("", ui(["Mode:", "Back", "Exit"], { calls }));
  const submenu = calls.find((call) => call.title.startsWith("Mode:"));
  assert.match(submenu.title, /\(\* is current\)/);
  const current = submenu.lines.find((line) => line.startsWith("fix "));
  assert.ok(current, "the current mode is listed");
  assert.match(current, /^fix \*/);
});

test("a valid choice clears the count of stray answers", async () => {
  const notes = [];
  const { deps, writes } = fakeDeps();
  // Two stray answers with a real choice in between: the menu stays open and warns twice.
  await createCommand(deps).handler("", ui([{ raw: "x" }, "Log", { raw: "y" }, "Exit"], { notes }));
  assert.deepEqual(writes, []);
  assert.equal(notes.filter((note) => /not one of the menu entries/.test(note.text)).length, 2);
  assert.equal(notes.filter((note) => /closing it/.test(note.text)).length, 0);
});

test("an answer that is not in the menu warns and leaves the menu open", async () => {
  const notes = [];
  const { deps, writes } = fakeDeps();
  const scripted = ui(["Exit"], { notes });
  let first = true;
  // The host answers with a string the menu never offered, then with a real entry: the menu warns
  // once and stays open instead of treating the first answer as a cancel.
  const strange = {
    hasUI: true,
    ui: {
      ...scripted.ui,
      select: async (title, lines) => {
        if (first) {
          first = false;
          return "something else";
        }
        return scripted.ui.select(title, lines);
      },
    },
  };
  await createCommand(deps).handler("", strange);
  assert.deepEqual(writes, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /not one of the menu entries/);
});

test("a host that only answers with nonsense closes the menu instead of spinning", async () => {
  const { deps, writes } = fakeDeps();
  let asked = 0;
  const stubborn = {
    hasUI: true,
    ui: {
      select: async () => {
        asked++;
        return "something else";
      },
      confirm: async () => false,
      notify: () => {},
    },
  };
  await createCommand(deps).handler("", stubborn);
  assert.equal(asked, 3);
  assert.deepEqual(writes, []);
});

// The wiring in index.js, which is the part a fake deps object does not cover.
test("the extension registers /hygiene and it writes the real config file", async (t) => {
  const env = setup(t, { mode: null, config: { mode: "on" } });
  assert.ok(env.commands.has("hygiene"));

  const writing = env.ctx({ answers: [], hasUI: true });
  await env.command("mode fix", writing);
  assert.equal(env.readConfigFile().mode, "fix");
  assert.match(writing.notes.at(-1).text, /saved mode fix/);

  const reading = env.ctx({ answers: [] });
  await env.command("status", reading);
  assert.match(reading.notes.at(-1).text, /mode fix/);
});
