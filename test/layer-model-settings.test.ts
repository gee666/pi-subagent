import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isAgentEnabledAtLayer, parseAgentFile, type AgentConfig } from "../agents.js";
import {
  getSubagentsToolDescription,
  selectParentModelForSubagent,
} from "../index.js";
import { resolveSubagentModel } from "../runner.js";
import { RESUME_PROVIDER } from "../shared.js";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "test",
    systemPrompt: "",
    source: "user",
    filePath: "/test-agent.md",
    ...overrides,
  };
}

describe("agent layer settings", () => {
  test("parses enabled/disabled and defaults absent settings to enabled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-layer-test-"));
    try {
      const configuredPath = path.join(dir, "configured.md");
      fs.writeFileSync(configuredPath, [
        "---",
        "name: configured",
        "description: configured agent",
        "first-layer: disabled",
        "last-layer: enabled",
        "---",
        "prompt",
      ].join("\n"));
      const configured = parseAgentFile(configuredPath, "user");
      assert.equal(configured?.firstLayer, false);
      assert.equal(configured?.lastLayer, true);

      const defaultsPath = path.join(dir, "defaults.md");
      fs.writeFileSync(defaultsPath, "---\nname: defaults\ndescription: defaults agent\n---\nprompt\n");
      const defaults = parseAgentFile(defaultsPath, "user");
      assert.equal(defaults?.firstLayer, true);
      assert.equal(defaults?.lastLayer, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bundled team-lead is disabled on the last layer", () => {
    const teamLead = parseAgentFile(path.join(process.cwd(), "agents", "team-lead.md"), "builtin");
    assert.equal(teamLead?.lastLayer, false);
    assert.equal(isAgentEnabledAtLayer(teamLead!, 3, 3), false);
  });

  test("filters first and last launch layers independently", () => {
    assert.equal(isAgentEnabledAtLayer(agent({ firstLayer: false }), 1, 3), false);
    assert.equal(isAgentEnabledAtLayer(agent({ firstLayer: false }), 2, 3), true);
    assert.equal(isAgentEnabledAtLayer(agent({ lastLayer: false }), 2, 3), true);
    assert.equal(isAgentEnabledAtLayer(agent({ lastLayer: false }), 3, 3), false);
  });

  test("requires both settings when max depth is one", () => {
    assert.equal(isAgentEnabledAtLayer(agent({ firstLayer: false }), 1, 1), false);
    assert.equal(isAgentEnabledAtLayer(agent({ lastLayer: false }), 1, 1), false);
  });
});

describe("current parent model inheritance", () => {
  test("current parent model overrides agent frontmatter", () => {
    assert.equal(
      resolveSubagentModel("anthropic/pinned", "openai/gpt-5.6-sol"),
      "openai/gpt-5.6-sol",
    );
  });

  test("agent model remains a compatibility fallback without live parent context", () => {
    assert.equal(resolveSubagentModel("anthropic/pinned"), "anthropic/pinned");
  });

  test("uses the current model for a normal tool call without looking backward", () => {
    const current = { provider: "openai", id: "gpt-5.6-sol" };
    const older = { provider: "anthropic", id: "claude-old" };
    assert.equal(
      selectParentModelForSubagent(current, older, older, older),
      current,
    );
  });

  test("recovers the preceding real model for our synthetic resume call", () => {
    const synthetic = { provider: RESUME_PROVIDER, id: "synthetic-tool-call" };
    const captured = { provider: "openai", id: "gpt-5.6-sol" };
    const historical = { provider: "anthropic", id: "claude-old" };
    assert.equal(
      selectParentModelForSubagent(synthetic, captured, historical, undefined),
      captured,
    );
  });

  test("scans historical real models only when the current model is synthetic", () => {
    const synthetic = { provider: RESUME_PROVIDER, id: "synthetic-tool-call" };
    const historical = { provider: "anthropic", id: "claude-sonnet" };
    assert.equal(
      selectParentModelForSubagent(synthetic, undefined, historical, undefined),
      historical,
    );
  });
});

describe("subagent usage guidance", () => {
  test("includes cost and selectivity guidance for every model", () => {
    const description = getSubagentsToolDescription();
    assert.match(description, /because they are expensive/i);
    assert.match(description, /exploration tasks in parallel/i);
  });
});
