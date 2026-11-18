import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { report, setup, sha256, until } from "./helpers.js";

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

test("shutdown aborts a running analysis and records it as aborted", async (t) => {
  const env = setup(t);
  env.host.execImpl = (_command, _args, options) =>
    new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "", code: null, killed: true })));
  env.fire("edit", env.write("a.py"));
  await until(() => env.calls.length === 1, "the analysis to start");
  env.shutdown();
  await until(() => env.records().some((r) => r.outcome === "aborted"), "an aborted record");
});
