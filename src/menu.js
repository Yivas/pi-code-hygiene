// The menu, as data and as lines. No host, no terminal, no theme: everything here is a pure
// function of its arguments, so it can be tested without a terminal and used by both paths.
//
// Layout: a header with the state, the entries, and a hint line. The entry under the cursor carries
// its description on the same line, in a second column, and the rest of the entries carry nothing.
// When the width cannot hold that column, the description of the selected entry drops to its own
// line under the list. Either way the menu has the same height for every cursor position, so
// moving up and down does not make it jump.
//
// The text is plain and ASCII: the caller may colour it afterwards, but measuring and truncating
// happen here, on characters a terminal shows as one column.

export const SELECTED = "> ";
export const PLAIN = "  ";
const GAP = 2;
// A description shorter than this is not worth a column of its own; it goes under the list.
const MIN_DESCRIPTION_ROOM = 8;

export function renderMenu({ header = [], items, selected = 0, hint = "" }, width = 72) {
  const columns = Math.max(20, Math.floor(width));
  const index = clampIndex(selected, items.length);
  const labels = items.map((item) => oneLine(item.label));
  const descriptions = items.map((item) => oneLine(item.desc));
  const labelColumn = Math.max(...labels.map((label) => widthOf(label)), 0);
  const room = columns - PLAIN.length - labelColumn - GAP;
  const twoColumns = descriptions.some((desc) => desc !== "") && room >= MIN_DESCRIPTION_ROOM;

  const lines = header.map((line) => truncate(oneLine(line), columns));
  if (lines.length > 0) lines.push("");

  labels.forEach((label, position) => {
    const isSelected = position === index;
    const prefix = isSelected ? SELECTED : PLAIN;
    const pad = " ".repeat(Math.max(0, labelColumn - widthOf(label)));
    const desc = isSelected && twoColumns ? trims(descriptions[position], room) : "";
    lines.push(trims(`${prefix}${label}${pad}${desc ? `${" ".repeat(GAP)}${desc}` : ""}`, columns));
  });

  if (!twoColumns) {
    lines.push("");
    lines.push(trims(`${" ".repeat(SELECTED.length)}${descriptions[index] ?? ""}`, columns));
  }

  if (hint) {
    lines.push("");
    lines.push(trims(oneLine(hint), columns));
  }
  return lines;
}

export function clampIndex(index, length) {
  if (!Number.isFinite(index) || length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, Math.trunc(index)));
}

// What a key does to the cursor. Navigation stops at both ends: a short list with a visible
// cursor should not hide where it started by wrapping.
export function reduceMenu(state, action, length) {
  const last = Math.max(0, length - 1);
  if (action === "up") return { ...state, selected: clampIndex(state.selected - 1, length) };
  if (action === "down") return { ...state, selected: clampIndex(state.selected + 1, length) };
  if (action === "first") return { ...state, selected: 0 };
  if (action === "last") return { ...state, selected: last };
  return state;
}

export function oneLine(text) {
  let flat = "";
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0);
    flat += code < 0x20 || code === 0x7f ? " " : char;
  }
  return flat.replace(/\s+/g, " ").trim();
}

export function widthOf(text) {
  return [...String(text)].length;
}

// Ends in three dots rather than an ellipsis: a legacy Windows console shows one and not the other.
export function truncate(text, width) {
  const chars = [...String(text)];
  if (chars.length <= width) return String(text);
  return `${chars.slice(0, Math.max(0, width - 3)).join("").trimEnd()}...`;
}

// Right side of a line: cut to the room it has and leave no trailing spaces behind.
function trims(text, width) {
  return truncate(text, width).trimEnd();
}

export const HINTS = {
  main: "up/down move, enter opens, esc closes",
  submenu: "up/down move, enter picks, esc goes back",
};
