import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import codeHygiene from "../src/index.js";
import { report, setup, sha256, until } from "./helpers.js";

const OWN = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));

test("shadow mode records an analysis and leaves the tool result alone", async (t) => {
  const env = setup(t);
  const file = env.write("secret-name.py", "password = 'hunter2'\n");

  assert.equal(env.fire("edit", file), undefined);
  const [record] = await until(() => env.records().filter((r) => r.outcome), "a record");

  assert.deepEqual(env.calls[0].args, ["-I", "-B", env.packageDir, file, "--json", "--no-update-check", "--threshold", "0.55"]);
  assert.equal(env.calls[0].command, env.python);
  assert.equal(record.outcome, "ok");
  assert.equal(record.squiggles, 1);
  assert.deepEqual(record.kinds, { deep_nesting: 1 });
  assert.equal(record.mode, "shadow");
  assert.match(record.path, /^[0-9a-f]{12}$/);
  // The log must not carry code, paths or diagnostic text.
  // Any real path or snippet would show up in the raw text, whatever the field.
  const text = env.logText();
  assert.ok(!text.includes("secret-name") && !text.includes("hunter2") && !text.includes(env.project));
});

test("on mode appends a short note, never an error, and does not repeat an identical note", async (t) => {
  const env = setup(t, { mode: "on" });
  env.host.execImpl = async () => ({
    stdout: report([
      { line: 5, kind: "noisy_comment", probability: 0.7 },
      { line: 9, kind: "swallowed_error", probability: 0.95 },
      { line: 2, kind: "free text from a future version", probability: 0.6 },
      { line: 7, kind: "deep_nesting", probability: 0.8 },
    ]),
    stderr: "",
    code: 0,
  });
  const file = env.write("a.py");

  const patch = await env.fire("write", file);
  assert.equal(patch.isError, undefined);
  assert.equal(patch.content.length, 2);
  assert.equal(patch.content[0].text, "ok");
  const lines = patch.content[1].text.split("\n");
  assert.match(lines[0], /^\[code-hygiene\] Heuristic/);
  assert.deepEqual(lines.slice(1, 4), [
    "  line 9: swallowed_error (0.95)",
    "  line 7: deep_nesting (0.80)",
    "  line 5: noisy_comment (0.70)",
  ]);
  assert.ok(!patch.content[1].text.includes("future version"));
  assert.equal(env.records().at(-1).kinds.other, 1);
  assert.equal(await env.fire("write", file), undefined);
});

test("on mode repeats a note only when it differs from the previous one for that file", async (t) => {
  const env = setup(t, { mode: "on" });
  const file = env.write("a.py");
  const outputs = ["deep_nesting", "noisy_comment", "deep_nesting"].map((kind) => report([{ line: 1, kind, probability: 0.9 }]));
  const shown = [];
  for (const stdout of outputs) {
    env.host.execImpl = async () => ({ stdout, stderr: "", code: 0 });
    shown.push(Boolean(await env.fire("edit", file)));
  }
  assert.deepEqual(shown, [true, true, true]);
});

test("a leading @ and a project below a folder named build are handled", async (t) => {
  const env = setup(t);
  const nested = env.write("build/app/a.py");
  const cwd = join(env.project, "build", "app");
  env.handler({ toolName: "edit", input: { path: "@a.py" } }, { cwd });
  await until(() => env.records().length > 0, "a record");
  assert.equal(env.records()[0].outcome, "ok");
  assert.equal(env.calls[0].args[3], nested);
  // A build folder inside the project is still ignored, in any letter case.
  env.handler({ toolName: "edit", input: { path: "Build/b.py" } }, { cwd: env.project });
  env.write("Build/b.py");
  await until(() => env.records().some((r) => r.skip === "ignored_dir"), "the ignored folder");
});

test("the mode file is read on every edit and a typo means off", async (t) => {
  const env = setup(t);
  delete process.env.PI_CODE_HYGIENE_MODE;
  const file = env.write("a.py");
  const modeFile = join(env.home, "mode");

  writeFileSync(modeFile, "on\n");
  assert.ok(await env.fire("edit", file));
  writeFileSync(modeFile, "onn\n");
  assert.equal(await env.fire("edit", file), undefined);
  assert.equal(env.calls.length, 1);
  rmSync(modeFile);
  env.fire("edit", file);
  await until(() => env.records().some((r) => r.mode === "shadow"), "a shadow record");
});

test("a mode written with space or capitals still works", async (t) => {
  const env = setup(t);
  delete process.env.PI_CODE_HYGIENE_MODE;
  const modeFile = join(env.home, "mode");

  let n = 0;
  for (const text of ["On\n", "  on  ", "FIX\n"]) {
    writeFileSync(modeFile, text);
    const target = env.write(`m${++n}.py`);
    if (text.toLowerCase().includes("fix")) assert.equal(await env.fire("edit", target), undefined);
    else assert.ok(await env.fire("edit", target), text);
    assert.equal(env.records().filter((r) => r.outcome === "bad_mode").length, 0, text);
  }
  assert.equal(env.records().at(-1).mode, "fix");

  // The environment variable is read the same way.
  writeFileSync(modeFile, "off\n");
  process.env.PI_CODE_HYGIENE_MODE = " FIX ";
  assert.equal(await env.fire("edit", env.write("env.py")), undefined); // no baseline was taken
  assert.equal(env.records().at(-1).mode, "fix");
  assert.equal(env.records().filter((r) => r.outcome === "bad_mode").length, 0);
});

test("a wrong value in one source is reported even when the other source is right", async (t) => {
  const env = setup(t);
  const modeFile = join(env.home, "mode");
  const warnings = () => env.records().filter((r) => r.outcome === "bad_mode");

  // Wrong file, right environment variable: the variable applies and the file is named.
  writeFileSync(modeFile, "onn\n");
  process.env.PI_CODE_HYGIENE_MODE = "on";
  assert.ok(await env.fire("edit", env.write("a.py")));
  assert.equal(env.records().at(-1).mode, "on");
  await until(warnings, "the warning about the file");
  assert.equal(warnings()[0].value, "onn");
});

test("an unknown mode value is never used and is recorded once, whatever it fell back to", async (t) => {
  const env = setup(t);
  const file = env.write("a.py");
  const warnings = () => env.records().filter((r) => r.outcome === "bad_mode");

  // No mode file at all: the default applies, and the rejected value is still named.
  process.env.PI_CODE_HYGIENE_MODE = "loud";
  await env.fire("edit", file);
  await until(warnings, "the warning");
  assert.equal(warnings()[0].value, "loud");
  await until(() => env.records().some((r) => r.mode === "shadow"), "a shadow analysis");
  assert.equal(env.calls.length, 1);

  // A second unknown value in the same session is not reported again.
  process.env.PI_CODE_HYGIENE_MODE = "louder";
  env.fire("edit", file);
  await until(() => env.records().length > 1, "another record");
  assert.equal(warnings().length, 1);
});

test("a value that cannot be printed safely is recorded as unprintable, and an empty file is not a typo", async (t) => {
  const env = setup(t);
  const modeFile = join(env.home, "mode");
  const warnings = () => env.records().filter((r) => r.outcome === "bad_mode");

  writeFileSync(modeFile, ""); // an empty file, as a truncated write leaves it
  process.env.PI_CODE_HYGIENE_MODE = `${'x'.repeat(40)}\u00df`;
  await env.fire("edit", env.write("a.py"));
  await until(warnings, "the warning");
  assert.equal(warnings()[0].value, "unprintable");
  await until(() => env.records().some((r) => r.mode === "shadow"), "a shadow analysis");
  assert.ok(!env.logText().includes("xxxx"));
});

test("output over the buffer limit is not counted as a timeout", async (t) => {
  const env = setup(t, { mode: "on" });
  env.host.execImpl = async () => ({ stdout: "{", stderr: "", code: 1, killed: true, truncated: true });
  assert.equal(await env.fire("edit", env.write("a.py")), undefined);
  assert.equal(env.records().at(-1).outcome, "truncated");
});

test("an exception from the host is recorded with the file id and does not escape", async (t) => {
  const env = setup(t, { mode: "on" });
  env.host.execImpl = async () => {
    throw new Error("spawn failed");
  };
  assert.equal(await env.fire("edit", env.write("a.py")), undefined);
  const record = env.records().at(-1);
  assert.equal(record.outcome, "internal_error");
  assert.match(record.path, /^[0-9a-f]{12}$/);
});

test("ignores events and files it should not analyze", async (t) => {
  const env = setup(t);
  env.fire("edit", env.write("a.py"), { isError: true });
  env.fire("read", env.write("b.py"));
  env.fire("write", env.write("notes.md"));
  // Without the session cwd a relative path would resolve against Pi's own directory.
  env.handler({ toolName: "write", input: { path: "c.py" } }, {});

  env.fire("write", env.write("node_modules/dep/index.js"));
  env.fire("write", env.write("dir/[slug].ts"));
  env.fire("write", env.write("big.py", "x = 1\n".repeat(40000)));
  await until(() => env.records().length >= 3, "skip records");

  assert.deepEqual(env.records().map((r) => r.skip).sort(), ["glob_chars", "ignored_dir", "too_large"]);
  assert.equal(env.calls.length, 0);
});

test("failures leave the result untouched and are recorded", async (t) => {
  const env = setup(t, { mode: "on" });
  const file = env.write("a.py");
  const failures = [
    [{ stdout: "", stderr: "", code: null, killed: true }, "timeout"],
    [{ stdout: "", stderr: "boom", code: 1 }, "error"],
    [{ stdout: "not json", stderr: "", code: 0 }, "bad_json"],
  ];
  for (const [result, outcome] of failures) {
    env.host.execImpl = async () => result;
    assert.equal(await env.fire("edit", file), undefined);
    assert.equal(env.records().at(-1).outcome, outcome);
  }
});

test("a broken install runs nothing", async (t) => {
  const env = setup(t, { install: false });
  assert.equal(env.fire("edit", env.write("a.py")), undefined);
  await until(() => env.records().length > 0, "a record");
  assert.equal(env.records()[0].skip, "python_missing");
  assert.equal(env.calls.length, 0);

  const tampered = setup(t, { mode: "on" });
  writeFileSync(join(tampered.packageDir, "__main__.py"), "changed");
  assert.equal(await tampered.fire("edit", tampered.write("a.py")), undefined);
  assert.equal(tampered.records()[0].skip, "pin_mismatch");
  assert.equal(tampered.calls.length, 0);

  // A manifest that does not pin the entry point is rejected, however valid its other lines.
  const partial = setup(t, { mode: "on" });
  writeFileSync(join(partial.home, "manifest.sha256"), `${sha256("weights")} *codehygiene/weights.npz\n`);
  assert.equal(await partial.fire("edit", partial.write("a.py")), undefined);
  assert.equal(partial.records()[0].skip, "manifest_invalid");
  assert.equal(partial.calls.length, 0);
});

test("off mode does nothing", async (t) => {
  const env = setup(t, { mode: "off" });
  assert.equal(await env.fire("edit", env.write("a.py")), undefined);
  assert.equal(env.calls.length, 0);
  assert.equal(env.logText(), "");
});

test("runs at most two analyses at once and refuses beyond eight waiting", async (t) => {
  const env = setup(t);
  const gates = [];
  let running = 0;
  let peak = 0;
  env.host.execImpl = () =>
    new Promise((resolve) => {
      running++;
      peak = Math.max(peak, running);
      gates.push(() => {
        running--;
        resolve({ stdout: report([]), stderr: "", code: 0 });
      });
    });

  for (let i = 0; i < 12; i++) env.fire("write", env.write(`f${i}.py`, `x = ${i}\n`));
  await until(() => env.records().filter((r) => r.skip === "busy").length === 2 && gates.length === 2, "two running, two refused");
  await until(() => {
    for (const open of gates.splice(0)) open();
    return env.records().filter((r) => r.outcome === "ok").length >= 10;
  }, "ten analyses");
  assert.equal(peak, 2);
  assert.equal(env.records().filter((r) => r.outcome === "ok").length, 10);
});

test("a newer edit of the same file replaces the pending analysis", async (t) => {
  const env = setup(t);
  const gates = [];
  env.host.execImpl = () => new Promise((resolve) => gates.push(() => resolve({ stdout: report([]), stderr: "", code: 0 })));
  env.fire("write", env.write("a.py", "a = 1\n"));
  env.fire("write", env.write("b.py", "b = 1\n"));
  await until(() => gates.length === 2, "both slots busy");

  const target = env.write("c.py", "c = 1\n");
  env.fire("write", target);
  env.fire("write", target);
  // Both edits of c.py wait for a slot; the first one is dropped when it gets one.
  await until(() => {
    for (const open of gates.splice(0)) open();
    return env.records().filter((r) => r.outcome === "ok").length >= 3;
  }, "three analyses");
  assert.equal(env.records().filter((r) => r.skip === "superseded").length, 1);
});

test("a file that changes during analysis produces no note", async (t) => {
  const env = setup(t, { mode: "on" });
  const file = env.write("a.py", "a = 1\n");
  env.host.execImpl = async () => {
    writeFileSync(file, "a = 2\n");
    return { stdout: report([{ line: 1, kind: "deep_nesting", probability: 0.9 }]), stderr: "", code: 0 };
  };
  assert.equal(await env.fire("edit", file), undefined);
  assert.equal(env.records().at(-1).stale, true);
});

test("every record names the version that wrote it", async (t) => {
  const env = setup(t);
  await env.fire("edit", env.write("a.py"));
  const [record] = await until(() => env.records().filter((r) => r.outcome === "ok"), "a record");
  assert.equal(record.v, OWN.version);
});

test("a session starts with one line saying which version runs and where the mode came from", async (t) => {
  const env = setup(t, { mode: null, config: { mode: "fix", threshold: 0.7 } });
  env.sessionStart("startup");
  const [record] = await until(() => env.records().filter((r) => r.outcome === "session"), "the session record");
  assert.equal(record.v, OWN.version);
  assert.equal(record.mode, "fix");
  assert.equal(record.mode_source, "config");
  assert.equal(record.threshold, "0.70");
  assert.equal(record.max_findings, 3);
  assert.equal(record.rounds, 2);
  assert.equal(record.reason, "startup");
  assert.equal(record.disk_version, OWN.version);
  assert.equal(record.stale, false);
});

test("the session line is written even with the mode off", async (t) => {
  const env = setup(t, { mode: null, config: { mode: "off" } });
  env.sessionStart("resume");
  const [record] = await until(() => env.records().filter((r) => r.outcome === "session"), "the session record");
  assert.equal(record.mode, "off");
  assert.equal(record.reason, "resume");
  assert.equal(record.mode_raw, "off");
});

test("the threshold in config.json is the one codehygiene gets", async (t) => {
  const env = setup(t, { mode: null, config: { mode: "shadow", threshold: 0.4 } });
  env.fire("edit", env.write("a.py"));
  await until(() => env.calls.length === 1, "the analysis");
  assert.equal(env.calls[0].args.at(-1), "0.40");
});

test("the fix rounds come from the configuration", async (t) => {
  const env = setup(t, { mode: null, config: { mode: "fix", rounds: 1 } });
  const file = env.write("a.py", "a = 1\n");
  env.host.execImpl = async () => ({
    stdout: report([{ line: 2, kind: "deep_nesting", probability: 0.9 }]),
    stderr: "",
    code: 0,
  });
  const first = await env.change(file, "a = 1\nb = 2\n");
  assert.match(first.content.at(-1).text, /pass 1 of 1/);
  const second = await env.change(file, "a = 1\nb = 2\nc = 3\n");
  assert.equal(second, undefined);
  assert.ok(env.records().some((r) => r.round_after === 1), "the round is recorded");
});

test("a mode change in the middle of a call does not reach that call", async (t) => {
  const env = setup(t, { mode: null, config: { mode: "fix" } });
  const file = env.write("a.py", "a = 1\n");
  env.host.execImpl = async () => {
    writeFileSync(join(env.home, "config.json"), JSON.stringify({ version: 1, mode: "on" }));
    return { stdout: report([{ line: 2, kind: "deep_nesting", probability: 0.9 }]), stderr: "", code: 0 };
  };
  await env.change(file, "a = 1\nb = 2\n");
  assert.equal(env.records().at(-1).mode, "fix");
  await env.fire("edit", file);
  assert.equal(env.records().at(-1).mode, "on");
});

test("the note limit in config.json applies to on mode", async (t) => {
  const env = setup(t, { mode: null, config: { mode: "on", maxFindings: 1 } });
  env.host.execImpl = async () => ({
    stdout: report([
      { line: 2, kind: "deep_nesting", probability: 0.9 },
      { line: 3, kind: "noisy_comment", probability: 0.8 },
    ]),
    stderr: "",
    code: 0,
  });
  const result = await env.fire("edit", env.write("a.py", "a = 1\n"));
  const note = result.content.at(-1).text;
  assert.equal(note.match(/^ {2}line /gm).length, 1);
  assert.equal(env.records().at(-1).shown, 1);
});

test("a broken configuration never reaches the tool result", async (t) => {
  const env = setup(t, {
    mode: null,
    config: { mode: "on", threshold: "oops\u0000", rounds: 99, surprise: "nonsense text" },
  });
  const result = await env.fire("edit", env.write("a.py"));
  assert.match(result.content.at(-1).text, /code-hygiene/);
  assert.ok(!result.content.some((part) => String(part.text).includes("oops")));
  assert.ok(!result.content.some((part) => String(part.text).includes("nonsense")));
  const warnings = env.records().filter((r) => r.outcome === "bad_config");
  assert.equal(warnings.length, 2);
  assert.deepEqual(
    warnings.map((w) => w.setting),
    ["threshold", "rounds"],
  );
});

test("a session that starts after a shutdown works again on the same instance", async (t) => {
  const env = setup(t);
  env.sessionStart("startup");
  env.shutdown();
  env.sessionStart("new");
  await env.fire("edit", env.write("a.py"));
  const [record] = await until(() => env.records().filter((r) => r.outcome === "ok"), "an analysis");
  assert.equal(record.mode, "shadow");
});

test("a warning is written once per session and armed again by the next one", async (t) => {
  const env = setup(t, { mode: null, config: { mode: "on", threshold: 0.47 } });
  await env.fire("edit", env.write("a.py"));
  await until(() => env.records().some((r) => r.outcome === "bad_config"), "the first warning");
  await env.fire("edit", env.write("b.py"));
  assert.equal(env.records().filter((r) => r.outcome === "bad_config").length, 1);

  env.sessionStart("new");
  await env.fire("edit", env.write("c.py"));
  await until(() => env.records().filter((r) => r.outcome === "bad_config").length === 2, "the second warning");
});

test("a mode written wrong in config.json leaves the mode off, not the default", async (t) => {
  const env = setup(t, { mode: null, config: { mode: "loud" } });
  await env.fire("edit", env.write("a.py"));
  const [warning] = await until(() => env.records().filter((r) => r.outcome === "bad_mode"), "the warning");
  assert.equal(warning.value, "loud");
  // off means no analysis at all: the typo cannot start processes.
  assert.equal(env.calls.length, 0);
});

test("a name clash while registering the command is recorded and does not break the load", async (t) => {
  const env = setup(t);
  const second = {
    on: () => {},
    exec: async () => ({ stdout: report([]), stderr: "", code: 0 }),
    registerCommand: () => {
      throw new Error("duplicate name");
    },
  };
  codeHygiene(second);
  const [record] = await until(() => env.records().filter((r) => r.outcome === "duplicate_command"), "the record");
  assert.equal(record.v, OWN.version);
});

test("a second activation takes over and the first one goes quiet", async (t) => {
  const env = setup(t);
  const file = env.write("a.py");
  await env.fire("edit", file);
  const before = env.records().length;

  const second = { on: () => {}, exec: async () => ({ stdout: report([]), stderr: "", code: 0 }), registerCommand: () => {} };
  codeHygiene(second);
  const [duplicate] = await until(() => env.records().filter((r) => r.outcome === "duplicate_load"), "the duplicate record");
  assert.equal(duplicate.v, OWN.version);

  await env.fire("edit", file);
  assert.equal(env.records().length, before + 1);
});

test("after a clean shutdown a new activation registers without complaint", async (t) => {
  const env = setup(t);
  env.shutdown();
  const second = { on: () => {}, exec: async () => ({ stdout: report([]), stderr: "", code: 0 }), registerCommand: () => {} };
  codeHygiene(second);
  assert.equal(env.records().filter((r) => r.outcome === "duplicate_load").length, 0);
});

test("shutdown aborts a running analysis and records it as aborted", async (t) => {
  const env = setup(t);
  env.host.execImpl = (_command, _args, options) =>
    new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "", code: null, killed: true })));
  env.fire("edit", env.write("a.py"));
  await until(() => env.calls.length === 1, "the analysis to start");
  env.shutdown();
  await until(() => env.records().some((r) => r.outcome === "aborted"), "an aborted record");
});
