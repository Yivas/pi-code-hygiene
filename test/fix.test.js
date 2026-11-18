import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { report, setup } from "./helpers.js";

const body = (count, replace = {}) =>
  `${Array.from({ length: count }, (_, i) => replace[i + 1] ?? `x = ${i + 1}`).join("\n")}\n`;
const finding = (line, kind, probability) => ({ line, kind, probability });
const answer = (...squiggles) => async () => ({ stdout: report(squiggles), stderr: "", code: 0 });
const noteOf = (result) => result?.content?.[1]?.text;

test("a note lists findings in the code just written, with a recipe, best first", async (t) => {
  const env = setup(t, { mode: "fix" });
  const file = env.write("a.py", body(20));
  env.host.execImpl = answer(
    finding(11, "deep_nesting", 0.9),
    finding(12, "noisy_comment", 0.7),
    finding(10, "swallowed_error", 0.95),
    finding(14, "deep_nesting", 0.99), // far from anything that changed
    finding(11, "poor_naming", 0.7), // below the higher bar this kind needs
    finding(11, "duplicate_block", 0.99), // never shown in fix mode
    finding(11, "dense_line", 0.6), // below the general bar
  );

  const result = await env.change(file, body(20, { 11: "y = 11" }));

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, "ok");
  assert.deepEqual(noteOf(result).split("\n"), [
    "[code-hygiene] Heuristic findings (they may be wrong) in lines you just changed:",
    "  line 10: swallowed_error (0.95) -> handle, log or rethrow; or comment why ignoring it is safe",
    "  line 11: deep_nesting (0.90) -> flatten with a guard clause or early return",
    "  line 12: noisy_comment (0.70) -> remove comments that restate the code; keep the why",
    "Fix only the real ones, in code you just wrote. Skip any fix that would change behavior, drop required",
    "error handling or clash with the project linter, and name what you skipped in one sentence.",
    "Do not edit untouched code to lower the score. (pass 1 of 2)",
  ]);
  const [record] = env.records();
  assert.equal(record.shown, 3);
  assert.deepEqual(record.suppressed, { outside_edit: 1, excluded: 1, threshold: 2 });
});

test("a new file counts as all written, and an unreadable one is not analyzed", async (t) => {
  const env = setup(t, { mode: "fix" });
  env.host.execImpl = answer(finding(14, "deep_nesting", 0.9));
  assert.match(noteOf(await env.change(`${env.project}/new.py`, body(20), "write")), /line 14: deep_nesting/);

  // A file larger than the limit has no baseline, so nothing it holds can be called new.
  const big = env.write("big.py", `${"x = 1\n".repeat(40000)}`);
  const result = await env.change(big, body(20));
  assert.equal(result, undefined);
});

test("a second edit that touches a flagged line is the re-check: final pass, then silence", async (t) => {
  const env = setup(t, { mode: "fix" });
  const file = env.write("a.py", body(30));

  env.host.execImpl = answer(finding(5, "deep_nesting", 0.9));
  assert.match(noteOf(await env.change(file, body(30, { 5: "y = 5" }))), /\(pass 1 of 2\)/);

  // An unrelated edit: the flagged line is not touched, and the same finding is not repeated.
  env.host.execImpl = answer(finding(5, "deep_nesting", 0.9), finding(25, "dense_line", 0.9));
  const unrelated = await env.change(file, body(30, { 5: "y = 5", 25: "y = 25" }));
  assert.match(noteOf(unrelated), /line 25: dense_line/);
  assert.doesNotMatch(noteOf(unrelated), /line 5:/);

  // The agent edits the flagged line and the finding is still there: one more time, labelled final.
  env.host.execImpl = answer(finding(5, "deep_nesting", 0.9));
  const final = await env.change(file, body(30, { 5: "z = 5", 25: "y = 25" }));
  assert.match(noteOf(final), /line 5: deep_nesting/);
  assert.match(noteOf(final), /\(final pass\)$/);
  const recheck = env.records().at(-1);
  assert.equal(recheck.recheck, true);
  assert.equal(recheck.round_after, 2);

  // Two rounds are all a file gets in a run.
  env.host.execImpl = answer(finding(7, "deep_nesting", 0.9));
  assert.equal(await env.change(file, body(30, { 5: "z = 5", 7: "q = 7" })), undefined);
  assert.deepEqual(env.records().at(-1).suppressed, { rounds: 1 });
});

test("when the re-check finds nothing left, the file goes quiet and the log says it was resolved", async (t) => {
  const env = setup(t, { mode: "fix" });
  const file = env.write("a.py", body(30));
  env.host.execImpl = answer(finding(5, "deep_nesting", 0.9));
  await env.change(file, body(30, { 5: "y = 5" }));

  env.host.execImpl = answer();
  assert.equal(await env.change(file, body(30, { 5: "if y: pass" })), undefined);
  const record = env.records().at(-1);
  assert.equal(record.recheck, true);
  assert.equal(record.resolved_flagged, 1);

  env.host.execImpl = answer(finding(9, "dense_line", 0.9));
  assert.equal(await env.change(file, body(30, { 5: "if y: pass", 9: "w = 9" })), undefined);
});

test("an edit whose analysis failed does not count as the re-check of a note it never answered", async (t) => {
  const env = setup(t, { mode: "fix" });
  const file = env.write("a.py", body(30));
  env.host.execImpl = answer(finding(5, "deep_nesting", 0.9));
  await env.change(file, body(30, { 5: "y = 5" }));

  // The analysis crashes; the edit still happened, right next to the line the note named (line 6
  // is within the margin of line 5).
  env.host.execImpl = async () => ({ stdout: "", stderr: "boom", code: 3 });
  assert.equal(await env.change(file, body(30, { 5: "y = 5", 6: "z = 6" })), undefined);

  // An unrelated edit must not be taken for the answer to that note, even though the crashed edit
  // touched the neighbourhood: only the file as it stands after that edit is compared.
  env.host.execImpl = answer(finding(5, "deep_nesting", 0.9), finding(20, "dense_line", 0.9));
  const unrelated = await env.change(file, body(30, { 5: "y = 5", 6: "z = 6", 20: "w = 20" }));
  assert.match(noteOf(unrelated), /line 20: dense_line/);
  assert.match(noteOf(unrelated), /\(pass 1 of 2\)$/);
  const record = env.records().at(-1);
  assert.equal(record.recheck, false);
  assert.equal(record.round, 1);

  // The edit that does touch the flagged line is the re-check, and it gets the final pass.
  const final = await env.change(file, body(30, { 5: "q = 5", 6: "z = 6", 20: "w = 20" }));
  assert.match(noteOf(final), /\(final pass\)$/);
});

test("a write after a note counts as the re-check", async (t) => {
  const env = setup(t, { mode: "fix" });
  const file = env.write("a.py", body(30));
  env.host.execImpl = answer(finding(5, "deep_nesting", 0.9));
  await env.change(file, body(30, { 5: "y = 5" }));
  const rewrite = await env.change(file, body(30, { 5: "y = 5", 8: "y = 8" }), "write");
  assert.match(noteOf(rewrite), /\(final pass\)$/);
});

test("a file gets at most three notes, and a run at most eight", async (t) => {
  const env = setup(t, { mode: "fix" });
  const file = env.write("a.py", body(40));
  const shown = [];
  let text = {};
  const found = [];
  for (const line of [3, 6, 9, 12]) {
    found.push(finding(line, "dense_line", 0.9)); // earlier findings stay while nobody fixes them
    env.host.execImpl = answer(...found);
    text = { ...text, [line]: `y = ${line}` };
    shown.push(Boolean(await env.change(file, body(40, text))));
  }
  assert.deepEqual(shown, [true, true, true, false]);
  assert.deepEqual(env.records().at(-1).suppressed, { repeated: 3, file_cap: 1 });

  const run = [];
  for (let i = 1; i <= 9; i++) {
    env.host.execImpl = answer(finding(3, "deep_nesting", 0.9));
    run.push(Boolean(await env.change(env.write(`f${i}.py`, body(10)), body(10, { 3: "y = 3" }))));
  }
  // Three notes went to a.py, so five more fit before the run runs out.
  assert.deepEqual(run, [true, true, true, true, true, false, false, false, false]);
  assert.deepEqual(env.records().at(-1).suppressed, { run_cap: 1 });

  env.startRun({});
  env.host.execImpl = answer(finding(3, "deep_nesting", 0.9));
  assert.ok(await env.change(env.write("g.py", body(10)), body(10, { 3: "y = 3" })));
});

test("a note stays within its character budget, dropping the weakest finding, and keeps at least one", async (t) => {
  const env = setup(t, { mode: "fix" });
  const file = env.write("a.py", body(1200));
  env.host.execImpl = answer(
    finding(1005, "special_casing", 0.99),
    finding(1006, "duplicate_block", 0.99),
    finding(1007, "special_casing", 0.98),
    finding(1008, "special_casing", 0.97),
  );
  const note = noteOf(await env.change(file, body(1200, { 1005: "a", 1006: "b", 1007: "c", 1008: "d" })));
  assert.ok(note.length <= 600, `${note.length} characters`);
  assert.equal(note.split("\n").filter((line) => line.startsWith("  line")).length, 2);
  assert.deepEqual(env.records().at(-1).suppressed, { excluded: 1, cap: 1 });
});

test("a blank line inserted at the top is blamed on the top, not on the last blank line", async (t) => {
  const env = setup(t, { mode: "fix" });
  const file = env.write("a.py", body(40, { 2: "", 30: "" }));
  // A finding on untouched line 32 must not be called the agent's; the one on the new blank line is.
  env.host.execImpl = answer(finding(32, "cramped_layout", 0.9), finding(3, "dense_line", 0.9));
  const lines = body(40, { 2: "", 30: "" }).split("\n");
  lines.splice(1, 0, "");
  const note = noteOf(await env.change(file, lines.join("\n")));
  assert.match(note, /line 3: dense_line/);
  assert.doesNotMatch(note, /line 32/);
});

test("without a baseline there are no notes, and only fix mode takes one", async (t) => {
  const env = setup(t, { mode: "on" });
  const file = env.write("a.py", body(20));
  env.host.execImpl = answer(finding(5, "deep_nesting", 0.9));

  // tool_call in `on` mode takes no baseline, so switching to `fix` afterwards finds none.
  env.before(file);
  process.env.PI_CODE_HYGIENE_MODE = "fix";
  writeFileSync(file, body(20, { 5: "y = 5" }));
  assert.equal(await env.result(file), undefined);
  assert.deepEqual(env.records().at(-1).suppressed, { no_baseline: 1 });

  // Other tools and files outside the analyzed set are ignored without a read or an error.
  env.before(file, "bash");
  env.before(env.write("notes.txt", "x"));
  env.before(env.write("node_modules/p/index.js", "x"));
  assert.equal(env.calls.length, 1);
});

test("the rule joins the system prompt in fix mode, once, and in no other mode", async (t) => {
  const env = setup(t, { mode: "fix" });
  const options = { promptGuidelines: ["an existing rule"] };
  env.startRun(options);
  env.startRun(options);
  assert.equal(options.promptGuidelines.length, 2);
  assert.match(options.promptGuidelines[1], /^Code-hygiene fix mode: .*requested scope and the project's linter and conventions take precedence/);

  const bare = {};
  env.startRun(bare);
  assert.equal(bare.promptGuidelines.length, 1);

  process.env.PI_CODE_HYGIENE_MODE = "on";
  const quiet = { promptGuidelines: [] };
  env.startRun(quiet);
  assert.deepEqual(quiet.promptGuidelines, []);
});

test("the log has counts only, never line text", async (t) => {
  const env = setup(t, { mode: "fix" });
  const file = env.write("a.py", body(12));
  env.host.execImpl = answer(finding(4, "swallowed_error", 0.9), finding(8, "deep_nesting", 0.8));
  await env.change(file, body(12, { 4: "secret_marker = 4" }));
  const [record] = env.records();
  assert.equal(record.squiggles, 2);
  assert.equal(record.findings_in_edit, 1);
  assert.ok(!env.logText().includes("secret_marker"));
});
