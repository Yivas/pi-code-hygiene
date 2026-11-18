import assert from "node:assert/strict";
import test from "node:test";
import { changedLines, fingerprint, isNear, splitLines } from "../src/lines.js";

test("splitLines numbers lines the way Python's splitlines does", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\nb"), ["a", "b"]);
  assert.deepEqual(splitLines("a\n\n"), ["a", ""]);
  assert.deepEqual(splitLines("a\fb"), ["a", "b"]);
  assert.deepEqual(splitLines(""), [""]);
  assert.deepEqual(splitLines("\n"), [""]);
});

test("changedLines finds the lines of the new text with no counterpart in the old one", () => {
  assert.deepEqual([...changedLines(["a", "b", "c"], ["a", "B", "c", "d"])], [2, 4]);
  assert.deepEqual([...changedLines(["a", "b"], ["a", "b"])], []);
  assert.deepEqual([...changedLines([], ["a", "b"])], [1, 2]);
});

test("changedLines blames an inserted line on where it was inserted, even for repeated lines", () => {
  assert.deepEqual([...changedLines(["a", "", "b", "", "c"], ["a", "", "", "b", "", "c"])], [3]);
  assert.deepEqual([...changedLines(["", "a", "", "b"], ["", "", "a", "", "b"])], [2]);
  assert.deepEqual([...changedLines(["}", "x"], ["}", "x", "}"])], [3]);
  assert.deepEqual([...changedLines(["a", "b", "c"], ["c", "a", "b"])], [1]);
});

test("changedLines handles a rewritten file too big for the table", () => {
  const old = Array.from({ length: 3000 }, (_, i) => `old ${i}`);
  const rewritten = Array.from({ length: 3000 }, (_, i) => (i % 2 ? `old ${i}` : `new ${i}`));
  const changed = changedLines(old, rewritten);
  assert.equal(changed.size, 1500);
  assert.ok(changed.has(1) && !changed.has(2));
});

test("isNear looks a margin around the changed lines", () => {
  const changed = new Set([10]);
  assert.equal(isNear(changed, 10, 1), true);
  assert.equal(isNear(changed, 11, 1), true);
  assert.equal(isNear(changed, 12, 1), false);
  assert.equal(isNear(new Set(), 5, 1), false);
});

test("a fingerprint follows its line, ignores spacing, and carries no text", () => {
  const before = ["def f():", "    if x:", "        pass"];
  const moved = ["# new", "def f():", "  if  x:", "        pass"];
  const a = fingerprint("deep_nesting", before, 2);
  assert.match(a, /^deep_nesting:[0-9a-f]{16}$/);
  assert.equal(fingerprint("deep_nesting", moved, 3), a);
  assert.notEqual(fingerprint("poor_naming", before, 2), a);
  assert.ok(!a.includes("if"));
  assert.equal(fingerprint("deep_nesting", before, 9), undefined);
});

test("a fingerprint of a bare closing line also depends on the line before it", () => {
  const lines = ["    return a", "}", "    return b", "}"];
  assert.notEqual(fingerprint("dense_line", lines, 2), fingerprint("dense_line", lines, 4));
});
