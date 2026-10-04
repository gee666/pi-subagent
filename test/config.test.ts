import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents } from "../agents.js";
import { findProjectConfig, loadPiSubagentsConfig } from "../config.js";

function tempDir(prefix: string): string {
  const root = path.join(process.cwd(), "tmp");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

describe("pi-subagents config", () => {
  test("loads complete tool prompt overrides from the nearest project config", () => {
    const root = tempDir("pi-subagent-config-");
    try {
      const configPath = path.join(root, ".pi", "pi-subagents.json");
      const nested = path.join(root, "packages", "app");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          "tool-prompts": {
            subagents: "project subagents prompt",
            resume_subagents: "project resume prompt",
          },
        }),
      );

      assert.equal(findProjectConfig(nested), configPath);
      const prompts = loadPiSubagentsConfig(nested, true).toolPrompts;
      assert.equal(prompts.subagents, "project subagents prompt");
      assert.equal(prompts.resume_subagents, "project resume prompt");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not load project prompt overrides when project config is not trusted", () => {
    const root = tempDir("pi-subagent-untrusted-config-");
    const uniqueTool = `untrusted_tool_${Date.now()}`;
    try {
      const configPath = path.join(root, ".pi", "pi-subagents.json");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          "tool-prompts": { [uniqueTool]: "must not load" },
        }),
      );

      assert.equal(loadPiSubagentsConfig(root, false).toolPrompts[uniqueTool], undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("user-created agent discovery", () => {
  test("has no bundled fallback and honors scopes and project overrides", () => {
    const root = tempDir("pi-subagent-agents-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(root, "user");
    try {
      const user = path.join(root, "user/agents");
      const project = path.join(root, ".pi/agents");
      fs.mkdirSync(user, { recursive: true });
      fs.mkdirSync(project, { recursive: true });
      assert.deepEqual(discoverAgents(root, "both").agents, []);
      fs.writeFileSync(path.join(project, "invalid.md"), "Not an agent definition.");
      assert.deepEqual(discoverAgents(root, "both").agents, []);
      fs.writeFileSync(path.join(user, "worker.md"), "---\nname: worker\ndescription: user worker\n---\nUser prompt.");
      fs.writeFileSync(
        path.join(project, "worker.md"),
        "---\nname: worker\ndescription: project worker\n---\nProject prompt.",
      );
      assert.deepEqual(
        discoverAgents(root, "user").agents.map((a) => [a.name, a.source]),
        [["worker", "user"]],
      );
      for (const scope of ["both", "project"] as const) {
        const found = discoverAgents(root, scope).agents;
        assert.equal(found.length, 1);
        assert.equal(found[0].source, "project");
        assert.equal(found[0].systemPrompt, "Project prompt.");
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
