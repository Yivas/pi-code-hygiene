import assert from "node:assert/strict";
import test from "node:test";
import { clampIndex, oneLine, reduceMenu, renderMenu, truncate, widthOf } from "../src/menu.js";

const items = [
  { key: "mode", label: "Mode: on", desc: "append a short note after an edit" },
  { key: "limits", label: "Threshold and notes", desc: "0.55, 3/note, 2 rounds" },
  { key: "status", label: "Status and diagnostics", desc: "version, install, log" },
  { key: "log", label: "Log", desc: "what was recorded last" },
];

const build = (selected, width, extra = {}) =>
  renderMenu({ header: ["pi-code-hygiene 0.4.0 | mode on (config)"], items, selected, hint: "up/down move", ...extra }, width);

test("only the row under the cursor carries its description", () => {
  for (const selected of [0, 1, 2, 3]) {
    const lines = build(selected, 100);
    const withDesc = items.filter((item) => lines.some((line) => line.includes(item.desc)));
    assert.deepEqual(
      withDesc.map((item) => item.key),
      [items[selected].key],
      `width 100, cursor ${selected}`,
    );
  }
});

test("the menu has the same height wherever the cursor is", () => {
  const heights = [0, 1, 2, 3].map((selected) => build(selected, 60).length);
  assert.equal(new Set(heights).size, 1);
});

test("every line fits the width and stays ASCII", () => {
  for (let width = 20; width <= 120; width += 2) {
    for (const selected of [0, 3]) {
      for (const line of build(selected, width)) {
        assert.ok(widthOf(line) <= width, `${line} fits ${width}`);
        assert.ok(!line.includes("\t") && !line.includes("\u001b") && !line.includes("\n"));
      }
    }
  }
});

test("exactly one row is marked as selected", () => {
  for (const selected of [0, 2, 3]) {
    const lines = build(selected, 80);
    assert.equal(lines.filter((line) => line.startsWith("> ")).length, 1, `cursor ${selected}`);
  }
});

test("a narrow menu puts the description under the list instead of squeezing it", () => {
  const lines = build(1, 30);
  const descLine = lines.find((line) => line.includes(items[1].desc.slice(0, 10)));
  assert.ok(descLine, "the description is somewhere");
  assert.ok(!descLine.startsWith("> "), "and not on the row itself");
});

test("the description column starts at the same place for every cursor position", () => {
  const columnAt = (selected) => {
    const line = build(selected, 100).find((entry) => entry.startsWith("> "));
    return line.indexOf(items[selected].desc);
  };
  const columns = [0, 1, 2].map(columnAt);
  assert.equal(new Set(columns).size, 1);
});

test("navigation stops at both ends and never leaves the list", () => {
  assert.equal(reduceMenu({ selected: 0 }, "up", 4).selected, 0);
  assert.equal(reduceMenu({ selected: 3 }, "down", 4).selected, 3);
  assert.equal(reduceMenu({ selected: 1 }, "down", 4).selected, 2);
  assert.equal(reduceMenu({ selected: 2 }, "first", 4).selected, 0);
  assert.equal(reduceMenu({ selected: 1 }, "last", 4).selected, 3);
  assert.equal(reduceMenu({ selected: 1 }, "other", 4).selected, 1);
});

test("an index outside the list is clamped, not trusted", () => {
  assert.equal(clampIndex(-5, 4), 0);
  assert.equal(clampIndex(99, 4), 3);
  assert.equal(clampIndex(Number.NaN, 4), 0);
  assert.equal(clampIndex(0, 0), 0);
});

test("text from outside is flattened and cut with three dots", () => {
  assert.equal(oneLine("a\nb\u001b[31m  c"), "a b [31m c");
  assert.equal(truncate("abcdefghij", 6), "abc...");
  assert.equal(truncate("abc", 6), "abc");
  assert.equal(widthOf("abc"), 3);
});
