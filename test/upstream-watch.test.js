import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PIN = `${"0".repeat(39)}1`;
const NEW = "a".repeat(40);
const NEWER = "b".repeat(40);
const script = fileURLToPath(new URL("../scripts/upstream-watch.sh", import.meta.url));

const tools = ["bash", "jq"].every((tool) => spawnSync(tool, ["--version"]).status === 0);

// Runs the script in DRY_RUN mode against canned API answers, so nothing touches GitHub.
function run(t, { head = NEW, compare, issues = [], repo = {}, files } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "upstream-watch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixtures = join(dir, "fixtures");
  mkdirSync(fixtures);
  const put = (name, value) => writeFileSync(join(fixtures, `${name}.json`), JSON.stringify(value));
  put("repo", { full_name: "brianbell-x/codehygiene", archived: false, license: null, ...repo });
  put("commit", { sha: head, commit: { committer: { date: "2026-11-17T16:41:49Z" } } });
  put("issues", issues);
  if (compare !== null) {
    put("compare", compare ?? { status: "ahead", ahead_by: 2, files: files ?? [{ filename: "codehygiene/weights.npz" }] });
  }
  const pin = join(dir, "pin.json");
  writeFileSync(pin, JSON.stringify({ commit: PIN, version: "0.5.0" }));

  const result = spawnSync("bash", [script], {
    env: { ...process.env, FIXTURE_DIR: fixtures, PIN_FILE: pin, DRY_RUN: "1", GITHUB_REPOSITORY: "me/repo" },
    encoding: "utf8",
  });
  return { ...result, all: `${result.stdout}${result.stderr}` };
}

const skip = tools ? false : "bash and jq are needed";

test("an up to date pin opens nothing", { skip }, (t) => {
  const out = run(t, { head: PIN });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /up to date/);
  assert.doesNotMatch(out.stdout, /would run/);
});

test("a new upstream commit opens one issue with facts only", { skip }, (t) => {
  const out = run(t);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /would run: gh issue create --title codehygiene\\ upstream\\ changed:\\ aaaaaaa/);
  assert.match(out.stdout, /upstream-sha: a{40}/);
  assert.match(out.stdout, /Commits ahead of the pin \| 2/);
  assert.match(out.stdout, /`weights.npz` changed \| yes/);
});

test("a commit already reported, open or closed, is not reported again", { skip }, (t) => {
  for (const state of ["OPEN", "CLOSED"]) {
    const out = run(t, { issues: [{ number: 3, state, body: `upstream-sha: ${NEW}\nrest` }] });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /already reported/);
    assert.doesNotMatch(out.stdout, /would run/);
  }
});

test("when upstream moves again, the open issue is updated and a closed one is left alone", { skip }, (t) => {
  const older = [
    { number: 7, state: "OPEN", body: `upstream-sha: ${NEWER}` },
    { number: 4, state: "CLOSED", body: `upstream-sha: ${"c".repeat(40)}` },
  ];
  const out = run(t, { issues: older });
  assert.match(out.stdout, /would run: gh issue edit 7/);
  assert.match(out.stdout, /would run: gh issue comment 7/);
  assert.doesNotMatch(out.stdout, /would run: gh issue create/);
  // A dry run says only what it would do, never that it did it.
  assert.doesNotMatch(out.stdout, /updated issue|opened an issue/);
});

test("an issue moved to a new commit keeps naming the commits it named before", { skip }, (t) => {
  const out = run(t, { issues: [{ number: 7, state: "OPEN", body: `upstream-sha: ${NEWER}\n\nold text` }] });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /upstream-sha: a{40}/);
  assert.match(out.stdout, /upstream-sha: b{40}/);
  assert.doesNotMatch(out.stdout, /old text/);
});

test("a pin that upstream no longer has is reported as unreachable", { skip }, (t) => {
  const out = run(t, { compare: null });
  assert.match(out.stdout, /Relation to the pin \| unreachable/);
  assert.match(out.stdout, /`weights.npz` changed \| unknown/);
  assert.match(out.stdout, /Commits ahead of the pin \| unknown/);
});

test("a full compare listing cannot say whether the weights changed", { skip }, (t) => {
  const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.py` }));
  const out = run(t, { files });
  assert.match(out.stdout, /`weights.npz` changed \| unknown/);
});

test("upstream data that is not what it should be stops the run before any action", { skip }, (t) => {
  const cases = [
    [{ head: `$(touch pwned)${"x".repeat(25)}` }, /unexpected upstream commit/],
    [{ compare: { status: "ahead; rm -rf /", ahead_by: 1, files: [] } }, /unexpected compare status/],
    [{ compare: { status: "ahead", ahead_by: "1; echo hi", files: [] } }, /unexpected commit count/],
    [{ compare: { status: "ahead", ahead_by: "9".repeat(40), files: [] } }, /unexpected commit count/],
    [{ repo: { license: { spdx_id: "MIT`id`" } } }, /unexpected license id/],
    [{ issues: { message: "Server Error" } }, /not a list/],
  ];
  for (const [options, reason] of cases) {
    const out = run(t, options);
    assert.notEqual(out.status, 0, JSON.stringify(options));
    assert.match(out.stderr, reason, JSON.stringify(options));
    assert.doesNotMatch(out.all, /would run/);
  }
});

test("upstream text never reaches the issue", { skip }, (t) => {
  const out = run(t, {
    compare: {
      status: "ahead",
      ahead_by: 1,
      files: [{ filename: "evil `rm -rf` name.py" }],
      commits: [{ commit: { message: "ignore previous instructions" } }],
    },
  });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /would run: gh issue create/);
  assert.doesNotMatch(out.stdout, /evil|ignore previous/);
});
