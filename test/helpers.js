import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codeHygiene from "../src/index.js";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const report = (squiggles) => JSON.stringify({ score: 0.29, squiggles });

// A fake Pi host and a fake codehygiene install in a temp folder. Nothing here runs Python.
export function setup(t, { mode = "shadow", install = true } = {}) {
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
  Object.assign(process.env, { PI_CODE_HYGIENE_HOME: home, PI_CODE_HYGIENE_PYTHON: python, PI_CODE_HYGIENE_MODE: mode });
  t.after(() => {
    for (const key of ["PI_CODE_HYGIENE_HOME", "PI_CODE_HYGIENE_PYTHON", "PI_CODE_HYGIENE_MODE"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true });
  });

  const handlers = new Map();
  const calls = [];
  const host = {
    execImpl: async () => ({ stdout: report([{ line: 3, kind: "deep_nesting", probability: 0.9 }]), stderr: "", code: 0 }),
    on: (event, handler) => handlers.set(event, handler),
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return host.execImpl(command, args, options);
    },
  };
  codeHygiene(host);

  const logFile = join(home, "state", "shadow.jsonl");
  return {
    home, project, python, packageDir, calls, host,
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
