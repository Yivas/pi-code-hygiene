import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIG_BAD_NAME,
  CONFIG_NAME,
  DEFAULTS,
  formatThreshold,
  readConfig,
  resetConfigCache,
  resolveHome,
  thresholdToCents,
  validatePatch,
  writeConfig,
} from "../src/config.js";

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-hygiene-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  resetConfigCache();
  return dir;
}

const put = (dir, value) => writeFileSync(join(dir, CONFIG_NAME), JSON.stringify(value));

test("with no file and no environment the defaults apply", (t) => {
  const home = folder(t);
  const snapshot = readConfig(home, {});
  assert.deepEqual(snapshot.values, DEFAULTS);
  assert.equal(snapshot.sources.mode, "default");
  assert.equal(snapshot.exists, false);
  assert.deepEqual(snapshot.rejected, []);
});

test("the environment wins for the mode and a typo in the file is still reported", (t) => {
  const home = folder(t);
  put(home, { mode: "onn" });
  const snapshot = readConfig(home, { PI_CODE_HYGIENE_MODE: " ON " });
  assert.equal(snapshot.values.mode, "on");
  assert.equal(snapshot.sources.mode, "env");
  assert.deepEqual(snapshot.rejected, [{ key: "mode", value: "onn" }]);
});

test("each key falls back on its own", (t) => {
  const home = folder(t);
  put(home, { mode: "fix", threshold: 0.7, maxFindings: 9, rounds: "3" });
  const snapshot = readConfig(home, {});
  assert.equal(snapshot.values.mode, "fix");
  assert.equal(snapshot.values.thresholdCents, 70);
  assert.equal(snapshot.values.maxFindings, DEFAULTS.maxFindings);
  assert.equal(snapshot.values.rounds, 3);
  assert.deepEqual(snapshot.rejected, [{ key: "maxFindings", value: "9" }]);
});

test("a comma decimal, a fraction and cents are all understood", (t) => {
  const home = folder(t);
  put(home, { threshold: "0,45" });
  assert.equal(readConfig(home, {}).values.thresholdCents, 45);
  put(home, { threshold: 55 });
  resetConfigCache();
  assert.equal(readConfig(home, {}).values.thresholdCents, 55);
  assert.equal(thresholdToCents("0.9"), 90);
  assert.equal(thresholdToCents("nonsense"), undefined);
  assert.equal(formatThreshold(55), "0.55");
});

test("the legacy mode file is read when the config has no mode", (t) => {
  const home = folder(t);
  put(home, { rounds: 1 });
  writeFileSync(join(home, "mode"), " Fix \n");
  const snapshot = readConfig(home, {});
  assert.equal(snapshot.values.mode, "fix");
  assert.equal(snapshot.sources.mode, "legacy");
  assert.equal(snapshot.rawMode, "Fix");
});

test("a config mode and a legacy mode that disagree are both visible", (t) => {
  const home = folder(t);
  put(home, { mode: "on" });
  writeFileSync(join(home, "mode"), "fix");
  const snapshot = readConfig(home, {});
  assert.equal(snapshot.values.mode, "on");
  assert.equal(snapshot.configMode, "on");
  assert.equal(snapshot.legacy, "fix");
});

test("a newer schema version is read and never downgraded", async (t) => {
  const home = folder(t);
  put(home, { version: 9, mode: "on", future: { keep: true } });
  const snapshot = readConfig(home, {});
  assert.equal(snapshot.schema, 9);
  assert.equal(snapshot.schemaKnown, false);
  const saved = await writeConfig(home, { rounds: 3 });
  assert.equal(saved.ok, true);
  const written = JSON.parse(readFileSync(join(home, CONFIG_NAME), "utf8"));
  assert.equal(written.version, 9);
  assert.deepEqual(written.future, { keep: true });
  assert.equal(written.mode, "on");
  assert.equal(written.rounds, 3);
});

test("the first save inherits the legacy mode so the file becomes the only source", async (t) => {
  const home = folder(t);
  writeFileSync(join(home, "mode"), "fix\n");
  await writeConfig(home, { rounds: 1 });
  const written = JSON.parse(readFileSync(join(home, CONFIG_NAME), "utf8"));
  assert.equal(written.mode, "fix");
  assert.equal(written.rounds, 1);
  // A later edit of the legacy file no longer changes what applies.
  writeFileSync(join(home, "mode"), "on\n");
  assert.equal(readConfig(home, {}).values.mode, "fix");
});

test("storing the threshold keeps two decimals in the file", async (t) => {
  const home = folder(t);
  await writeConfig(home, { thresholdCents: 65 });
  const written = JSON.parse(readFileSync(join(home, CONFIG_NAME), "utf8"));
  assert.equal(written.threshold, 0.65);
  assert.equal(written.thresholdCents, undefined);
});

test("a corrupt file is kept as .bad before it is replaced", async (t) => {
  const home = folder(t);
  writeFileSync(join(home, CONFIG_NAME), "{ this is not json");
  const snapshot = readConfig(home, {});
  assert.deepEqual(snapshot.problems, ["invalid_json"]);
  const saved = await writeConfig(home, { mode: "on" });
  assert.equal(saved.ok, true);
  assert.equal(readFileSync(join(home, CONFIG_BAD_NAME), "utf8"), "{ this is not json");
  assert.equal(readConfig(home, {}).values.mode, "on");
});

test("a BOM does not stop the file from loading", (t) => {
  const home = folder(t);
  writeFileSync(join(home, CONFIG_NAME), `\uFEFF${JSON.stringify({ mode: "fix" })}`);
  assert.equal(readConfig(home, {}).values.mode, "fix");
});

test("a rename that cannot happen is reported without throwing", async (t) => {
  const home = folder(t);
  // A directory where the file should be makes the rename fail on every platform.
  mkdirSync(join(home, CONFIG_NAME));
  const saved = await writeConfig(home, { mode: "on" }, { delay: () => Promise.resolve() });
  assert.deepEqual(saved, { ok: false, error: "rename_failed" });
  assert.equal(existsSync(join(home, `${CONFIG_NAME}.${process.pid}.tmp`)), true);
});

test("the cache follows the file and the environment", (t) => {
  const home = folder(t);
  put(home, { mode: "on" });
  assert.equal(readConfig(home, {}).values.mode, "on");
  put(home, { mode: "fix" });
  assert.equal(readConfig(home, {}).values.mode, "fix");
  assert.equal(readConfig(home, { PI_CODE_HYGIENE_MODE: "shadow" }).values.mode, "shadow");
  assert.equal(readConfig(home, {}).values.mode, "fix");
});

test("validatePatch accepts what the menu offers and rejects the rest", () => {
  assert.deepEqual(validatePatch({ mode: " Fix ", thresholdCents: "0.6", maxFindings: "2" }).clean, {
    mode: "fix",
    thresholdCents: 60,
    maxFindings: 2,
  });
  assert.deepEqual(validatePatch({ threshold: 0.47 }).rejected, [{ key: "threshold", value: "0.47" }]);
  assert.deepEqual(validatePatch({ rounds: 5 }).rejected, [{ key: "rounds", value: "5" }]);
  assert.deepEqual(validatePatch({ mode: "loud" }).rejected, [{ key: "mode", value: "loud" }]);
  assert.deepEqual(validatePatch({ nope: 1 }).rejected, [{ key: "nope", value: "1" }]);
});

test("the install folder comes from the environment", () => {
  assert.equal(resolveHome({ PI_CODE_HYGIENE_HOME: "C:/tmp/home" }), "C:/tmp/home");
  const fallback = resolveHome({ LOCALAPPDATA: "C:/local" });
  assert.equal(fallback.endsWith("pi-hygiene"), true);
});
