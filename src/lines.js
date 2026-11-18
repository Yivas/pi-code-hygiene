// Line helpers for the extension: split text the way codehygiene counts lines, find which lines
// an edit changed, and fingerprint a finding without keeping any code.

import { createHash } from "node:crypto";

// codehygiene splits with Python's str.splitlines(), so a line number it reports must be read
// against the same separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the point.
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

export function splitLines(text) {
  const lines = text.split(LINE_BREAKS);
  // splitlines() yields no empty line after a final line break, and "" for an empty text.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

// The longest-common-subsequence table is skipped above this many cells: 4 million cells of four
// bytes each is 15 MiB, and the comparison runs twice per edit.
const MAX_TABLE_CELLS = 4_000_000;

// Returns the numbers, in the new text, of the lines the edit wrote: those that are not part of
// the longest run of lines the two texts share in the same order. Lines the edit left in place
// do not count, so numbers need no tracking across edits, and an inserted blank line is blamed
// on the place where it was inserted, not on whichever blank line comes last.
//
// Equal lines at the start and the end are skipped first, so an edit of a few lines costs almost
// nothing even in a large file. If what remains is too big for the table (a rewritten file),
// lines are matched by text wherever they sit, one old line for one new line; that cannot tell
// repeated lines such as "}" apart, which the margin around a finding mostly absorbs, and it
// reports nothing for a file whose lines were only reordered.
//
// Inside a run of identical lines (blank lines, closing braces) the changed line is reported as
// the last of the run, so the blame can land a few lines below where the edit happened; the
// margin around a finding covers runs of up to three.
export function changedLines(oldLines, newLines) {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const changed = new Set();
  const n = oldEnd - start;
  const m = newEnd - start;
  if (m === 0) return changed;
  if (n === 0) {
    for (let j = 0; j < m; j++) changed.add(start + j + 1);
    return changed;
  }

  if ((n + 1) * (m + 1) > MAX_TABLE_CELLS) {
    const available = new Map();
    for (let i = start; i < oldEnd; i++) available.set(oldLines[i], (available.get(oldLines[i]) ?? 0) + 1);
    for (let j = start; j < newEnd; j++) {
      const left = available.get(newLines[j]) ?? 0;
      if (left > 0) available.set(newLines[j], left - 1);
      else changed.add(j + 1);
    }
    return changed;
  }

  // table[i][j]: length of the longest common subsequence of the last n-i old and m-j new lines.
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        oldLines[start + i] === newLines[start + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && oldLines[start + i] === newLines[start + j]) {
      i++;
      j++;
    } else if (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++;
    } else {
      changed.add(start + j + 1);
      j++;
    }
  }
  return changed;
}

// True when `line` is a changed line or within `margin` lines of one.
export function isNear(changed, line, margin) {
  for (let n = line - margin; n <= line + margin; n++) if (changed.has(n)) return true;
  return false;
}

// Identifies a finding by its kind and the text of its line, so the same problem is recognized
// after the line moves. Only a short hash leaves this function; the text never does.
export function fingerprint(kind, lines, number) {
  const text = lines[number - 1];
  if (text === undefined) return undefined;
  let basis = squash(text);
  // A line such as "}" repeats everywhere, so the line before it joins the basis.
  if (basis.length < 4 && number > 1) basis = `${squash(lines[number - 2])}\n${basis}`;
  return `${kind}:${createHash("sha256").update(basis).digest("hex").slice(0, 16)}`;
}

function squash(text) {
  return text.trim().replace(/\s+/g, " ");
}
