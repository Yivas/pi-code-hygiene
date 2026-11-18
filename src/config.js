// Configuration for pi-code-hygiene: one JSON file in the install folder, validated key by key.
//
// The install folder used to hold a plain `mode` file. That file is still read, so an install
// from an older version keeps working, but nothing writes it any more: `config.json` is the only
// source the menu and the command write. Precedence is per key, not per file: the environment
// wins for the mode, then the config file, then the legacy file, then the defaults. A key that is
// present but not understood falls back to its own default and never invalidates the rest.
//
// Nothing here throws at a caller: a broken file must never break an edit.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_NAME = "config.json";
export const CONFIG_BAD_NAME = "config.json.bad";
export const LEGACY_MODE_NAME = "mode";
export const SCHEMA_VERSION = 1;
export const MODES = ["shadow", "on", "fix", "off"];

export const DEFAULTS = Object.freeze({ mode: "shadow", thresholdCents: 55, maxFindings: 3, rounds: 2 });

// The menu offers these values; these are also the ranges the file may hold.
export const THRESHOLD_CENTS = Object.freeze([40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]);
export const MAX_FINDINGS = Object.freeze([1, 2, 3]);
export const ROUNDS = Object.freeze([1, 2, 3, 4]);

const RANGES = {
  thresholdCents: { min: 40, max: 90, step: 5 },
  maxFindings: { min: 1, max: 3, step: 1 },
  rounds: { min: 1, max: 4, step: 1 },
};

const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_MS = 20;

const cache = new Map(); // home -> { stamp, value }

// The install folder, resolved per call so a test can point it somewhere else at any time.
export function resolveHome(env = process.env) {
  return env.PI_CODE_HYGIENE_HOME ?? join(env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "pi-hygiene");
}

export function normalizeMode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// The threshold travels to codehygiene as a decimal string; it is validated and stored in cents
// so 0.55 cannot become 0.5499999 through floating point.
export function formatThreshold(cents) {
  return (cents / 100).toFixed(2);
}

export function thresholdToCents(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    // Accept 0.55 as a fraction and 55 as cents: both get typed by hand.
    return value > 1 ? Math.round(value) : Math.round(value * 100);
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(text)) return undefined;
  const number = Number(text);
  return number > 1 ? Math.round(number) : Math.round(number * 100);
}

function inRange(key, value) {
  const range = RANGES[key];
  if (!Number.isInteger(value)) return undefined;
  if (value < range.min || value > range.max) return undefined;
  if ((value - range.min) % range.step !== 0) return undefined;
  return value;
}

function readable(value) {
  if (typeof value === "string") return /^[\x20-\x7e]{1,16}$/.test(value) ? value : "unprintable";
  if (typeof value === "number" || typeof value === "boolean") return String(value).slice(0, 16);
  return "unprintable";
}

function stampOf(file) {
  try {
    const stats = statSync(file);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "missing";
  }
}

// Reads every source and resolves one snapshot. The result is cached until the file changes, so a
// check per edit costs a stat at most.
export function readConfig(home, env = process.env) {
  const file = join(home, CONFIG_NAME);
  // The legacy file is part of the stamp too: it is still a live source for the mode, and a
  // change there has to be seen on the next call, not on the next process.
  const stamp = `${stampOf(file)}|${stampOf(join(home, LEGACY_MODE_NAME))}|${normalizeMode(env.PI_CODE_HYGIENE_MODE)}`;
  const cached = cache.get(home);
  if (cached && cached.stamp === stamp) return cached.value;

  const value = resolveSnapshot(file, home, env);
  cache.set(home, { stamp, value });
  return value;
}

function resolveSnapshot(file, home, env) {
  const rejected = [];
  const problems = [];
  const raw = readRaw(file, problems);

  let legacyRaw;
  try {
    legacyRaw = readFileSync(join(home, LEGACY_MODE_NAME), "utf8");
  } catch {
    legacyRaw = undefined;
  }
  const legacy = normalizeMode(legacyRaw) || undefined;

  const sources = {};
  const values = {};

  const mode = pickMode(
    [
      ["env", normalizeMode(env.PI_CODE_HYGIENE_MODE) || undefined],
      ["config", configModeCandidate(raw?.mode)],
      ["legacy", legacy],
    ],
    rejected,
  );
  values.mode = mode.value;
  sources.mode = mode.source;

  for (const key of ["thresholdCents", "maxFindings", "rounds"]) {
    const candidate = key === "thresholdCents" ? (raw?.threshold ?? raw?.thresholdCents) : raw?.[key];
    const parsed = candidate === undefined ? undefined : inRange(key, parseNumber(key, candidate));
    values[key] = parsed === undefined ? DEFAULTS[key] : parsed;
    sources[key] = parsed === undefined ? "default" : "config";
    // Report the key the file holds, not the internal name of the unit.
    if (candidate !== undefined && parsed === undefined) {
      rejected.push({ key: key === "thresholdCents" ? "threshold" : key, value: readable(candidate) });
    }
  }

  const schema = raw?.version;
  // The value that was actually configured for the mode, before any normalisation, so the session
  // line can show what the user wrote next to what applied.
  const rawMode =
    [env.PI_CODE_HYGIENE_MODE, raw?.mode, legacyRaw].find(
      (value) => typeof value === "string" && value.trim() !== "",
    ) ?? null;
  return {
    values,
    sources,
    // Trailing newlines are how these files get written by hand; they are not worth reporting.
    rawMode: rawMode === null ? null : readable(rawMode.trim()),
    rejected,
    problems,
    // Anything above what this build understands is read for the keys it knows and left alone.
    schema: Number.isInteger(schema) ? schema : SCHEMA_VERSION,
    schemaKnown: !Number.isInteger(schema) || schema <= SCHEMA_VERSION,
    legacy: MODES.includes(legacy) ? legacy : undefined,
    configMode: MODES.includes(normalizeMode(raw?.mode)) ? normalizeMode(raw?.mode) : undefined,
    exists: existsSync(file),
  };
}

// Every layer is examined, not only the winner: a typo in the legacy file is worth reporting even
// when a valid environment variable is what applies, which is how it was reported before. A typo in
// a file never starts processes: when no source is valid and a file was there saying something
// else, the mode is `off`, so a misspelt `off` cannot turn into analyses. An unusable environment
// variable alone is not a file mistake, and the mode stays at its default, as it always has.
// An empty string counts as not set; any other type is a value that was written and is wrong.
function configModeCandidate(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return normalizeMode(value) || undefined;
  return String(value);
}

function pickMode(layers, rejected) {
  let chosen;
  let wrongFile = false;
  for (const [source, candidate] of layers) {
    if (candidate === undefined) continue;
    if (!MODES.includes(candidate)) {
      rejected.push({ key: "mode", value: readable(candidate) });
      if (source !== "env") wrongFile = true;
      continue;
    }
    chosen ??= { value: candidate, source };
  }
  if (chosen) return chosen;
  return wrongFile ? { value: "off", source: "rejected" } : { value: DEFAULTS.mode, source: "default" };
}

function parseNumber(key, value) {
  if (key === "thresholdCents") return thresholdToCents(value);
  if (typeof value === "number") return value;
  const text = typeof value === "string" ? value.trim() : "";
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

function readRaw(file, problems) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") problems.push("unreadable");
    return undefined;
  }
  try {
    // Notepad and PowerShell write a BOM; JSON.parse refuses it.
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      problems.push("not_an_object");
      return undefined;
    }
    return parsed;
  } catch {
    problems.push("invalid_json");
    return undefined;
  }
}

// Merges a patch into what is on disk right now, keeps unknown keys, and swaps the file in with a
// rename. The retry covers Windows, where another process holding the file makes the rename fail.
export async function writeConfig(home, patch, { delay = wait } = {}) {
  const file = join(home, CONFIG_NAME);
  const problems = [];
  const raw = readRaw(file, problems) ?? {};
  const corrupt = problems.includes("invalid_json") || problems.includes("not_an_object");

  try {
    mkdirSync(home, { recursive: true });
    // Keep what the user wrote before replacing it, so a bad file is reportable and recoverable.
    if (corrupt && existsSync(file)) copyFileSync(file, join(home, CONFIG_BAD_NAME));
  } catch {
    return { ok: false, error: "unwritable_folder" };
  }

  const next = { ...raw };
  // The first save makes the file the only source: if it has no mode yet, the value that applies
  // today (the legacy file) is copied in, so a later edit of that file cannot change the mode
  // behind the menu's back. Nothing is written at start-up, only when someone saves something.
  if (next.mode === undefined && patch.mode === undefined) {
    const inherited = inheritedMode(home);
    if (inherited !== undefined) next.mode = inherited;
  }
  const existing = Number.isInteger(raw.version) ? raw.version : SCHEMA_VERSION;
  // Never rewrite a schema version this build does not understand.
  next.version = existing > SCHEMA_VERSION ? existing : SCHEMA_VERSION;
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.thresholdCents !== undefined) next.threshold = patch.thresholdCents / 100;
  if (patch.maxFindings !== undefined) next.maxFindings = patch.maxFindings;
  if (patch.rounds !== undefined) next.rounds = patch.rounds;

  // A name per process: two sessions saving at once must not overwrite each other's temporary.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch {
    return { ok: false, error: "unwritable_folder" };
  }

  const saved = await swap(tmp, file, delay);
  cache.delete(home);
  return saved ? { ok: true } : { ok: false, error: "rename_failed" };
}

async function swap(tmp, file, delay) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    try {
      renameSync(tmp, file);
      return true;
    } catch {
      if (attempt + 1 < WRITE_ATTEMPTS) await delay(WRITE_RETRY_MS);
    }
  }
  // The old file is still in place and still loads; the caller says it could not save.
  try {
    writeFileSync(tmp, "");
  } catch {
    // Nothing else to do; a stray empty temporary file is harmless.
  }
  return false;
}

function inheritedMode(home) {
  try {
    const value = normalizeMode(readFileSync(join(home, LEGACY_MODE_NAME), "utf8"));
    return MODES.includes(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Turns user-facing values into the keys the file holds, rejecting what is not allowed.
export function validatePatch(patch) {
  const clean = {};
  const rejected = [];
  for (const [key, value] of Object.entries(patch)) {
    const name = key === "threshold" ? "thresholdCents" : key;
    let parsed;
    if (name === "mode") parsed = normalizeMode(value);
    else if (name === "thresholdCents") parsed = inRange(name, thresholdToCents(value));
    else if (name === "maxFindings" || name === "rounds") parsed = inRange(name, parseNumber(name, value));
    if (parsed === undefined || (name === "mode" && !MODES.includes(parsed))) {
      // Report the key as the caller typed it: `threshold` reads better than `thresholdCents`.
      rejected.push({ key, value: readable(value) });
      continue;
    }
    clean[name] = parsed;
  }
  return { clean, rejected };
}

// Test hook: forget the cached snapshots.
export function resetConfigCache() {
  cache.clear();
}
