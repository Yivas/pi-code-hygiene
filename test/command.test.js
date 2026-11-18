import assert from "node:assert/strict";
import test from "node:test";
import { createCommand } from "../src/command.js";
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

function ui(answers = [], { notes } = {}) {
  const queue = [...answers];
  return {
    hasUI: true,
    ui: {
      select: async () => (queue.length > 0 ? queue.shift() : undefined),
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
  await command.handler("", ui(["Mode", "fix", "Exit"], { notes }));
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
  await command.handler("", ui(["Threshold and notes", "Threshold 0.55", "0.65", "Back", "Exit"]));
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
  assert.match(notes[0].text, /install: manifest_missing — regenerate manifest\.sha256/);
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
