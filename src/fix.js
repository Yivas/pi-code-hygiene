// `fix` mode: decides which findings the agent is told about and when to stop.
//
// The aim is the cycle codehygiene's author describes for agents: fix, re-check, and stop after
// two passes. Per file and per agent run it works in rounds:
//   round 0  nothing shown yet. The first note lists findings in the code the agent wrote.
//   round 1  that note is open. The next edit that touches a flagged line is the re-check: what
//            is still flagged is listed once more as the "final pass", and the file goes quiet.
//            Edits that touch nothing flagged are no re-check; they may add notes for new
//            findings, under a small per-file backstop.
//   round 2  silent for the rest of the run.
// "Code the agent wrote" is the difference between the file as it was before its first edit of
// the run and the file now, so there are no line numbers to keep in step across edits.
// A run starts with a user message, not with every model response, so a follow-up message does
// not reset these budgets; only a new run does.
//
// Nothing here stores or returns code. Findings are identified by a short hash of their line.

import { changedLines, fingerprint, isNear } from "./lines.js";

function clampRounds(value) {
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : FIX.maxRounds;
}

function clampFindings(value) {
  return Number.isInteger(value) && value >= 1 && value <= 3 ? value : FIX.maxFindings;
}

export const FIX = {
  minProbability: 0.65,
  strictKinds: new Map([["poor_naming", 0.75], ["special_casing", 0.75]]),
  // duplicate_block needs both copies in the edit, and codehygiene reports one line.
  excludedKinds: new Set(["duplicate_block"]),
  lineMargin: 1,
  maxFindings: 3,
  noteMaxChars: 600,
  maxRounds: 2,
  maxNotesPerFile: 3,
  maxNotesPerRun: 8,
  maxCharsPerRun: 4000,
  maxFilesTracked: 32,
};

// What each kind usually calls for. Constants of this package: the text of the analyzed code
// never reaches a note. Each recipe carries its own condition so none pushes toward a change of
// behavior or toward dropping error handling.
const RECIPES = {
  deep_nesting: "flatten with a guard clause or early return",
  poor_naming: "rename to state intent; longer names are fine",
  noisy_comment: "remove comments that restate the code; keep the why",
  swallowed_error: "handle, log or rethrow; or comment why ignoring it is safe",
  dense_line: "split into named intermediate steps",
  special_casing: "fold into the general path only if behavior is identical",
  duplicate_block: "extract shared logic only if the copies must stay identical",
  cramped_layout: "add blank lines between logical steps",
  other: "review the line",
};

// Added to the system prompt in `fix` mode. Constant text, so the prompt changes only when the
// mode does.
export const FIX_GUIDELINE =
  "Code-hygiene fix mode: notes after edits come from codehygiene, a heuristic with false positives. " +
  "The user's requested scope and the project's linter and conventions take precedence. " +
  "Only fix flagged issues inside code you just wrote; never change behavior to satisfy a note, " +
  "and never edit untouched code to improve its score.";

const SILENT = Object.freeze({ findings: [], label: undefined, text: "" });

// Plain note for the findings and the round. Findings are already limited in number.
export function formatFixNote(findings, label, maxRounds = FIX.maxRounds) {
  const lines = findings.map(
    (f) => `  line ${f.line}: ${f.kind} (${f.probability.toFixed(2)}) -> ${RECIPES[f.kind] ?? RECIPES.other}`,
  );
  return [
    "[code-hygiene] Heuristic findings (they may be wrong) in lines you just changed:",
    ...lines,
    "Fix only the real ones, in code you just wrote. Skip any fix that would change behavior, drop required",
    "error handling or clash with the project linter, and name what you skipped in one sentence.",
    label === "final pass"
      ? "These remain after your last edit. Do not edit untouched code to lower the score. (final pass)"
      : `Do not edit untouched code to lower the score. (pass 1 of ${maxRounds})`,
  ].join("\n");
}

export function createFixTurn() {
  const files = new Map(); // file -> { base, prev, round, flagged, shown, notes }
  let notes = 0;
  let chars = 0;

  return {
    // Called before the first edit of a file in a run with its lines then: null when the file
    // does not exist yet, undefined when it cannot be read. Later calls change nothing.
    begin(file, baseLines) {
      if (files.has(file) || files.size >= FIX.maxFilesTracked) return;
      const base = baseLines === null ? [] : baseLines;
      files.set(file, { base, prev: base, round: 0, flagged: new Set(), shown: new Set(), notes: 0 });
    },

    // Called when an edit happened but its analysis cannot be used (the file changed while it
    // ran, or it failed): the edit is real, so the next comparison must start after it.
    observe(file, lines) {
      const state = files.get(file);
      if (state) state.prev = lines;
    },

    // Called after an edit with the file's lines and the findings (line, kind, probability, best
    // first). Returns what to tell the agent, and counts for the log. `limits` carries the values
    // of the configuration snapshot taken for this call; without it the constants above apply.
    review(file, lines, findings, { wrote = false, limits } = {}) {
      const maxRounds = clampRounds(limits?.rounds);
      const maxFindings = clampFindings(limits?.maxFindings);
      const state = files.get(file);
      if (!state || state.base === undefined) return { ...SILENT, suppressed: { no_baseline: findings.length } };

      const sinceStart = changedLines(state.base, lines);
      const sinceLast = changedLines(state.prev, lines);
      state.prev = lines;

      const items = findings.map((finding) => ({ ...finding, fp: fingerprint(finding.kind, lines, finding.line) }));
      const suppressed = {};
      const count = (reason, n = 1) => {
        if (n > 0) suppressed[reason] = (suppressed[reason] ?? 0) + n;
      };

      const candidates = [];
      let inEdit = 0;
      for (const item of items) {
        if (!item.fp) continue;
        if (!isNear(sinceStart, item.line, FIX.lineMargin)) {
          count("outside_edit");
          continue;
        }
        inEdit++;
        if (FIX.excludedKinds.has(item.kind)) count("excluded");
        else if (item.probability < (FIX.strictKinds.get(item.kind) ?? FIX.minProbability)) count("threshold");
        else candidates.push(item);
      }
      const stats = { findings_in_edit: inEdit, round: state.round };

      // A re-check is an edit that touched a flagged line, or removed a flagged finding.
      let pool = candidates;
      let label = `pass 1 of ${maxRounds}`;
      if (state.round >= maxRounds) {
        count("rounds", candidates.length);
        return { ...SILENT, suppressed, stats };
      }
      if (state.round === 1) {
        const present = items.filter((item) => item.fp && state.flagged.has(item.fp));
        // A flagged line whose text changed has a new fingerprint, so it counts as resolved here;
        // if the problem is still there it comes back as a candidate for the final pass.
        const resolved = state.flagged.size - new Set(present.map((item) => item.fp)).size;
        const touched =
          wrote || resolved > 0 || present.some((item) => isNear(sinceLast, item.line, FIX.lineMargin));
        stats.recheck = touched;
        stats.resolved_flagged = resolved;
        stats.persisted_flagged = state.flagged.size - resolved;
        if (touched) {
          state.round = maxRounds;
          label = "final pass";
        } else {
          pool = candidates.filter((item) => !state.shown.has(item.fp));
          count("repeated", candidates.length - pool.length);
        }
      }

      if (notes >= FIX.maxNotesPerRun || chars >= FIX.maxCharsPerRun) {
        count("run_cap", pool.length);
        return { ...SILENT, suppressed, stats };
      }
      if (state.notes >= FIX.maxNotesPerFile) {
        count("file_cap", pool.length);
        return { ...SILENT, suppressed, stats };
      }

      // As many findings as fit the note budget, best first, but at least one.
      let picked = pool.slice(0, maxFindings);
      let text = formatFixNote(picked, label, maxRounds);
      while (picked.length > 1 && text.length > FIX.noteMaxChars) {
        picked = picked.slice(0, -1);
        text = formatFixNote(picked, label, maxRounds);
      }
      if (picked.length === 0) return { ...SILENT, suppressed, stats };
      count("cap", pool.length - picked.length);

      for (const item of picked) {
        state.shown.add(item.fp);
        if (label !== "final pass") state.flagged.add(item.fp);
      }
      if (state.round === 0) state.round = 1;
      state.notes++;
      notes++;
      chars += text.length;
      return { findings: picked, label, text, suppressed, stats: { ...stats, round_after: state.round } };
    },
  };
}
