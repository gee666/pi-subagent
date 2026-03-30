import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runAgentSubprocess } from "../runner.js";
import { buildSubagentDetails } from "../types.js";
import type { AgentConfig } from "../agents.js";

const makeDetails = (results: any[]) =>
  buildSubagentDetails("single", "spawn", null, results);

const fakeAgent: AgentConfig = {
  name: "test-agent",
  description: "test",
  systemPrompt: "hello",
  source: "user" as const,
  filePath: "/fake",
};

const baseOpts = {
  cwd: process.cwd(),
  task: "test",
  delegationMode: "spawn" as const,
  parentDepth: 0,
  parentAgentStack: [] as string[],
  maxDepth: 3,
  preventCycles: false,
  makeDetails,
};

describe("runAgentSubprocess — unknown agent", () => {
  test("returns exitCode 1 and agentSource unknown", async () => {
    const result = await runAgentSubprocess({
      ...baseOpts,
      agents: [],
      agentName: "nonexistent",
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.agentSource, "unknown");
    assert.ok(
      result.stderr.includes("nonexistent"),
      `Expected stderr to include 'nonexistent', got: ${result.stderr}`,
    );
  });

  test("error message includes 'Available agents'", async () => {
    const result = await runAgentSubprocess({
      ...baseOpts,
      agents: [],
      agentName: "nonexistent",
    });

    assert.ok(
      result.stderr.includes("Available agents"),
      `Expected stderr to include 'Available agents', got: ${result.stderr}`,
    );
  });

  test("error message includes names of all available agents", async () => {
    const alpha: AgentConfig = { ...fakeAgent, name: "alpha" };
    const beta: AgentConfig = { ...fakeAgent, name: "beta" };

    const result = await runAgentSubprocess({
      ...baseOpts,
      agents: [alpha, beta],
      agentName: "gamma",
    });

    assert.ok(
      result.stderr.includes("alpha"),
      `Expected stderr to include 'alpha', got: ${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("beta"),
      `Expected stderr to include 'beta', got: ${result.stderr}`,
    );
  });
});

describe("runAgentSubprocess — fork mode without snapshot", () => {
  test("returns exitCode 1 and stopReason error", async () => {
    const result = await runAgentSubprocess({
      ...baseOpts,
      agents: [fakeAgent],
      agentName: "test-agent",
      delegationMode: "fork",
      forkSessionSnapshotJsonl: undefined,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stopReason, "error");
  });
});
