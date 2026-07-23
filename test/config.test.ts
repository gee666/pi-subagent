import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents, SUBAGENT_HIDE_BUILTIN_AGENTS_ENV } from "../agents.js";
import { findProjectConfig, loadPiSubagentsConfig } from "../config.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("pi-subagents config", () => {
  test("loads complete tool prompt overrides from the nearest project config", () => {
    const root = tempDir("pi-subagent-config-");
    try {
      const configPath = path.join(root, ".pi", "pi-subagents.json");
      const nested = path.join(root, "packages", "app");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        "tool-prompts": {
          subagents: "project subagents prompt",
          resume_subagents: "project resume prompt",
        },
      }));

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
      fs.writeFileSync(configPath, JSON.stringify({
        "tool-prompts": { [uniqueTool]: "must not load" },
      }));

      assert.equal(loadPiSubagentsConfig(root, false).toolPrompts[uniqueTool], undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("built-in agent discovery", () => {
  test("keeps built-ins with custom agents and supports hiding them by env", () => {
    const root = tempDir("pi-subagent-agents-");
    const previous = process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV];
    try {
      const agentsDir = path.join(root, ".pi", "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, "custom.md"),
        "---\nname: custom-agent\ndescription: custom\n---\nCustom prompt.\n",
      );

      delete process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV];
      const visible = discoverAgents(root, "both").agents;
      assert.ok(visible.some((agent) => agent.name === "custom-agent" && agent.source === "project"));
      assert.ok(visible.some((agent) => agent.source === "builtin"));

      process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV] = "true";
      const hidden = discoverAgents(root, "both").agents;
      assert.ok(hidden.some((agent) => agent.name === "custom-agent"));
      assert.equal(hidden.some((agent) => agent.source === "builtin"), false);
    } finally {
      if (previous === undefined) delete process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV];
      else process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV] = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("lets a custom agent override a built-in with the same name", () => {
    const root = tempDir("pi-subagent-agent-override-");
    const previous = process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV];
    try {
      delete process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV];
      const agentsDir = path.join(root, ".pi", "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentsDir, "code-writer.md"),
        "---\nname: code-writer\ndescription: project writer\n---\nProject prompt.\n",
      );

      const matches = discoverAgents(root, "both").agents.filter(
        (agent) => agent.name === "code-writer",
      );
      assert.equal(matches.length, 1);
      assert.equal(matches[0].source, "project");
      assert.equal(matches[0].description, "project writer");
    } finally {
      if (previous === undefined) delete process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV];
      else process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV] = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
