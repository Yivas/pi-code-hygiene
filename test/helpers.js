import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfigCache } from "../src/config.js";
import codeHygiene from "../src/index.js";

const ACTIVATION = Symbol.for("pi-code-hygiene.activation");

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const report = (squiggles) => JSON.stringify({ score: 0.29, squiggles });

// A fake Pi host and a fake codehygiene install in a temp folder. Nothing here runs Python.
// `mode: null` leaves PI_CODE_HYGIENE_MODE unset, which is what the configuration tests need:
// with the variable set, the environment outranks the file and the file would never be read.
export function setup(t, { mode = "shadow", install = true, config } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-code-hygiene-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const packageDir = join(home, "src", "codehygiene");
  const python = join(home, "python-stub");
  mkdirSync(packageDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (install) {
    writeFileSync(python, "stub");
    writeFileSync(join(packageDir, "__main__.py"), "main");
    writeFileSync(join(home, "manifest.sha256"), `${sha256("main")} *codehygiene/__main__.py\n`);
  }

  const saved = { ...process.env };
  // A shell that exported these would otherwise decide what the test reads.
  for (const key of Object.keys(process.env)) if (key.startsWith("PI_CODE_HYGIENE_")) delete process.env[key];
  Object.assign(process.env, { PI_CODE_HYGIENE_HOME: home, PI_CODE_HYGIENE_PYTHON: python });
  if (mode !== null && mode !== undefined) process.env.PI_CODE_HYGIENE_MODE = mode;
  if (config !== undefined) writeFileSync(join(home, "config.json"), JSON.stringify(config, null, 2));
  t.after(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith("PI_CODE_HYGIENE_")) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (key.startsWith("PI_CODE_HYGIENE_")) process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  });
  resetConfigCache();
  delete globalThis[ACTIVATION];

  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const host = {
    execImpl: async () => ({ stdout: report([{ line: 3, kind: "deep_nesting", probability: 0.9 }]), stderr: "", code: 0 }),
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, definition) => commands.set(name, definition),
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return host.execImpl(command, args, options);
    },
  };
  codeHygiene(host);

  const logFile = join(home, "state", "shadow.jsonl");
  return {
    home, project, python, packageDir, calls, host, commands,
    configPath: join(home, "config.json"),
    // A command context: scripted answers for the dialogs, and a record of every notification.
    ctx: ({ hasUI = true, answers = [] } = {}) => {
      const queue = [...answers];
      const notes = [];
      const ui = {
        select: async () => (queue.length > 0 ? queue.shift() : undefined),
        confirm: async () => (queue.length > 0 ? queue.shift() : false),
        input: async () => (queue.length > 0 ? queue.shift() : undefined),
        notify: (text, level) => notes.push({ text, level }),
      };
      return { hasUI, ui, notes };
    },
    command: (args, context) => commands.get("hygiene").handler(args, context),
    sessionStart: (reason = "startup") => handlers.get("session_start")?.({ reason }),
    readConfigFile: () => {
      try {
        return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      } catch {
        return undefined;
      }
    },
    write: (name, text = "x = 1\n") => {
      const file = join(project, name);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
      return file;
    },
    handler: (event, ctx) => handlers.get("tool_result")(event, ctx),
    fire: (toolName, path, extra = {}) =>
      handlers.get("tool_result")({ toolName, input: { path }, content: [{ type: "text", text: "ok" }], ...extra }, { cwd: project }),
    // What Pi does around one edit: tool_call before the file changes, tool_result after.
    before: (file, toolName = "edit") => handlers.get("tool_call")({ toolName, input: { path: file } }, { cwd: project }),
    result: (file, toolName = "edit") =>
      handlers.get("tool_result")(
        { toolName, input: { path: file }, content: [{ type: "text", text: "ok" }] },
        { cwd: project },
      ),
    change: (file, text, toolName = "edit") => {
      handlers.get("tool_call")({ toolName, input: { path: file } }, { cwd: project });
      writeFileSync(file, text);
      return handlers.get("tool_result")(
        { toolName, input: { path: file }, content: [{ type: "text", text: "ok" }] },
        { cwd: project },
      );
    },
    // A run starts: Pi calls this hook with the structured options of the system prompt.
    startRun: (systemPromptOptions) => handlers.get("before_agent_start")({ systemPromptOptions }),
    shutdown: () => handlers.get("session_shutdown")(),
    records: () => {
      try {
        return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
    logText: () => {
      try {
        return readFileSync(logFile, "utf8");
      } catch {
        return "";
      }
    },
  };
}

export async function until(check, label) {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (Array.isArray(value) ? value.length > 0 : value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}
