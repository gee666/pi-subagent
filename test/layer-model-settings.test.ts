import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  filterAdvertisedAgents,
  isAgentEnabledAtLayer,
  parseAgentFile,
  type AgentConfig,
} from "../agents.js";
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

  test("bundled team-lead is available only to the main agent", () => {
    const teamLead = parseAgentFile(path.join(process.cwd(), "agents", "team-lead.md"), "builtin");
    assert.equal(teamLead?.firstLayer, "only");
    assert.equal(isAgentEnabledAtLayer(teamLead!, 1, 3), true);
    assert.equal(isAgentEnabledAtLayer(teamLead!, 2, 3), false);
    assert.equal(isAgentEnabledAtLayer(teamLead!, 3, 3), false);
    assert.equal(isAgentEnabledAtLayer(teamLead!, 1, 1), true);
    assert.deepEqual(filterAdvertisedAgents([teamLead!], 2, 3, [], false), []);
  });

  test("parses second-layer and signed nth-layer selectors", () => {
    const root = path.join(process.cwd(), "tmp");
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, "layer-selectors-"));
    try {
      const file = path.join(dir, "agent.md");
      fs.writeFileSync(file, [
        "---", "name: selected", "description: selected layers",
        "second-layer: disabled", "nth-layer(1,2,5, -1, -1, -5): only",
        "---", "prompt",
      ].join("\n"));
      const parsed = parseAgentFile(file, "user")!;
      assert.equal(parsed.secondLayer, false);
      assert.deepEqual(parsed.layerRules, [{ layers: [1, 2, 5, -1, -5], setting: "only" }]);
      assert.deepEqual(
        Array.from({ length: 8 }, (_, i) => i + 1).filter((depth) => isAgentEnabledAtLayer(parsed, depth, 8)),
        [1, 4, 5, 8],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("combines only rules and lets disabled win regardless of rule order", () => {
    const selected = agent({ firstLayer: "only", lastLayer: "only", secondLayer: true });
    assert.deepEqual([1, 2, 3, 4].map((depth) => isAgentEnabledAtLayer(selected, depth, 4)), [true, false, false, true]);
    assert.equal(isAgentEnabledAtLayer(agent({ secondLayer: "only" }), 2, 3), true);
    assert.equal(isAgentEnabledAtLayer(agent({ secondLayer: "only" }), 1, 3), false);
    assert.equal(isAgentEnabledAtLayer(agent({ firstLayer: "only", lastLayer: false }), 1, 1), false);
    for (const layerRules of [
      [{ layers: [2], setting: "only" as const }, { layers: [-2], setting: false }],
      [{ layers: [-2], setting: false }, { layers: [2], setting: "only" as const }],
    ]) {
      assert.equal(isAgentEnabledAtLayer(agent({ layerRules }), 2, 3), false);
    }
  });

  test("enabled leaves other layers alone and negative selectors follow max depth", () => {
    const selected = agent({ layerRules: [{ layers: [-2], setting: "only" }] });
    assert.equal(isAgentEnabledAtLayer(selected, 2, 3), true);
    assert.equal(isAgentEnabledAtLayer(selected, 2, 4), false);
    assert.equal(isAgentEnabledAtLayer(selected, 3, 4), true);
    assert.equal(isAgentEnabledAtLayer(agent({ layerRules: [{ layers: [2], setting: true }] }), 1, 3), true);
    assert.equal(isAgentEnabledAtLayer(agent({ layerRules: [{ layers: [9, -9], setting: "only" }] }), 1, 3), false);
    for (const depth of [0, -1, 4, 1.5, NaN]) {
      assert.equal(isAgentEnabledAtLayer(agent(), depth, 3), false);
    }
    assert.equal(isAgentEnabledAtLayer(agent(), 1, 0), false);
  });

  test("warns and ignores malformed selectors and unsupported settings", () => {
    const root = path.join(process.cwd(), "tmp");
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, "invalid-layers-"));
    const warnings: string[] = [];
    const previousWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
      const file = path.join(dir, "agent.md");
      fs.writeFileSync(file, [
        "---", "name: invalid", "description: invalid layers",
        "nth-layer(0): only", "nth-layer(1.5): only", "nth-layer(1,): only",
        "nth-layer(): only", "nth-layer(9007199254740992): only",
        "second-layer: unsupported", "nth-layer(2): unsupported",
        "---", "prompt",
      ].join("\n"));
      const parsed = parseAgentFile(file, "user")!;
      assert.equal(parsed.secondLayer, true);
      assert.deepEqual(parsed.layerRules, [{ layers: [2], setting: true }]);
      assert.equal(warnings.length, 7);
      assert.equal(isAgentEnabledAtLayer(parsed, 1, 3), true);
    } finally {
      console.warn = previousWarn;
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  test("does not advertise agents already in the delegation stack", () => {
    const agents = [
      agent({ name: "code-architect" }),
      agent({ name: "code-reviwer" }),
      agent({ name: "code-writer" }),
    ];

    assert.deepEqual(
      filterAdvertisedAgents(
        agents,
        2,
        3,
        ["code-architect", "code-reviwer"],
        true,
      ).map((candidate) => candidate.name),
      ["code-writer"],
    );
  });

  test("keeps stacked agents visible when cycle prevention is disabled", () => {
    const agents = [agent({ name: "code-architect" }), agent({ name: "code-writer" })];
    assert.deepEqual(
      filterAdvertisedAgents(agents, 2, 3, ["code-architect"], false)
        .map((candidate) => candidate.name),
      ["code-architect", "code-writer"],
    );
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
  test("requires savings, a task-wide budget, and explicit nested allowances", () => {
    const description = getSubagentsToolDescription();
    assert.match(description, /parallel work will save substantial time/);
    assert.match(description, /crowd out your context and force compaction/);
    assert.match(description, /Every new agent costs money/);
    assert.match(description, /Set max_agents_allowed on every task/);
    assert.match(description, /include the assigned agent and everyone below it/);
    assert.match(description, /Respect any tighter user limit/);
    assert.match(description, /exactly the number of slots reserved/);
    assert.doesNotMatch(description, /max_subagents_allowed|max_agents_in_branch|1 slot plus/);
    assert.match(description, /Siblings get separate shares/);
    assert.match(description, /not workers each building teams/);
    assert.match(description, /before deep research/);
    assert.match(description, /tmp\/ directory, using its absolute path/);
    assert.doesNotMatch(description, /Resumes still cost money|substantial follow-up|short follow-ups yourself/);
    assert.match(description, /When to launch new subagents/);
    assert.doesNotMatch(description, /team-lead|code-writer|code-architect|code-reviwer/);
    assert.ok(description.split(/\s+/).length < 450);
  });

  test("specialists weigh delegation costs without mentioning team-lead", () => {
    for (const name of ["code-writer", "code-architect", "code-reviwer"]) {
      const specialist = parseAgentFile(path.join(process.cwd(), "agents", `${name}.md`), "builtin");
      assert.ok(specialist);
      assert.match(specialist.systemPrompt, /outweighs startup and handoff costs/);
      assert.match(specialist.systemPrompt, /Launch new subagents/);
      assert.doesNotMatch(specialist.systemPrompt, /ask your caller/i);
      assert.doesNotMatch(specialist.description + specialist.systemPrompt, /team.?lead/i);
      assert.match(specialist.systemPrompt, /handoff file/);
    }
  });

  test("team-lead requires a bounded scope and shares the root budget", () => {
    const lead = parseAgentFile(path.join(process.cwd(), "agents", "team-lead.md"), "builtin");
    assert.ok(lead);
    assert.match(lead.description, /Use (?:extremely )?rarely/);
    assert.doesNotMatch(lead.systemPrompt, /ask your caller|ask for it/i);
    assert.match(lead.systemPrompt, /not a fresh budget/);
    assert.match(lead.systemPrompt, /Another coordinator needs its own demonstrated context saving/);
    assert.match(lead.systemPrompt, /Launch new workers only/);
    assert.doesNotMatch(lead.systemPrompt, /substantial follow-up|Fix small integration issues yourself|repeated review rounds|Do small tasks/);
  });
});
