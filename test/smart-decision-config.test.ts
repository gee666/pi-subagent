import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadPiSubagentsConfig } from "../config.js";
import { createExtensionHarness } from "./helpers/extension.js";

const settings = {
  enabled: true,
  fallback: false,
  model: "jev",
  api_key: "test-secret",
  use_models: [{ "p/m/high": "Hard tasks" }],
};
function setup() {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/smart-config-"));
  const project = path.join(root, "project");
  const user = path.join(root, "user");
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.mkdirSync(user);
  return {
    root,
    project,
    user,
    projectFile: path.join(project, ".pi/pi-subagents.json"),
    userFile: path.join(user, "pi-subagents.json"),
  };
}

test("smart settings honor project trust and replace whole sections by precedence", () => {
  const dirs = setup();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dirs.user;
  try {
    fs.writeFileSync(dirs.userFile, JSON.stringify({ "smart-decision": settings }));
    fs.writeFileSync(
      dirs.projectFile,
      JSON.stringify({ "smart-decision": { enabled: false }, "tool-prompts": { subagents: "Project prompt" } }),
    );
    assert.equal(loadPiSubagentsConfig(dirs.project, false).smartDecision?.fallback, false);
    assert.equal(loadPiSubagentsConfig(dirs.project, true).smartDecision, undefined);
    fs.writeFileSync(dirs.projectFile, JSON.stringify({ "smart-decision": { ...settings, api_key: "project-key" } }));
    assert.equal(loadPiSubagentsConfig(dirs.project, true).smartDecision?.apiKey, "project-key");
    fs.writeFileSync(dirs.projectFile, JSON.stringify({ "tool-prompts": { subagents: "Project prompt" } }));
    const inherited = loadPiSubagentsConfig(dirs.project, true);
    assert.equal(inherited.smartDecision?.apiKey, settings.api_key);
    assert.equal(inherited.toolPrompts.subagents, "Project prompt");
    fs.writeFileSync(dirs.projectFile, JSON.stringify({ "smart-decision": { ...settings, use_models: [] } }));
    assert.equal(loadPiSubagentsConfig(dirs.project, true).smartDecision, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("trusted project settings reach the parallel subagents tool and strict errors stay credential-free", async (t) => {
  const dirs = setup();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dirs.user;
  const tasks: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    tasks.push(JSON.parse(String(init?.body)).state.task);
    throw new Error(settings.api_key);
  });
  try {
    fs.writeFileSync(dirs.projectFile, JSON.stringify({ "smart-decision": settings }));
    const harness = createExtensionHarness();
    const baseCtx = harness.makeCtx([], { cwd: dirs.project, isProjectTrusted: () => true });
    const ctx = { ...baseCtx, sessionManager: { ...baseCtx.sessionManager, getSessionDir: () => dirs.root } };
    await harness.emit("session_start", {}, ctx);
    const result = await harness.call(
      "subagents",
      "smart-call",
      {
        tasks: [
          { agent: "code-writer", task: "Implement bounded change", max_subagents_allowed: 0 },
          { agent: "code-reviwer", task: "Review bounded change", max_subagents_allowed: 0 },
        ],
      },
      ctx,
    );
    assert.equal(result.isError, true);
    assert.equal(result.details.results.length, 2);
    assert.deepEqual(tasks.sort(), ["Implement bounded change", "Review bounded change"]);
    for (const item of result.details.results) {
      assert.equal(item.exitCode, 1);
      assert.match(item.errorMessage!, /Fallback is disabled/);
    }
    assert.equal(JSON.stringify(result).includes(settings.api_key), false);
    await harness.emit("session_shutdown", {}, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});
