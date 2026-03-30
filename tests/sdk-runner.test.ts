import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runAgentSameProcess } from "../runner-sdk.js";
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
  modelRegistry: {} as any,
  parentModel: undefined,
  makeDetails,
};

describe("runAgentSameProcess — unknown agent", () => {
  test("returns exitCode 1 and agentSource unknown", async () => {
    const result = await runAgentSameProcess({
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
    const result = await runAgentSameProcess({
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

    const result = await runAgentSameProcess({
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

describe("runAgentSameProcess — fork mode without snapshot", () => {
  test("returns exitCode 1 and stopReason error", async () => {
    const result = await runAgentSameProcess({
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

describe("runAgentSameProcess vs runAgentSubprocess — structural parity", () => {
  test("both runners return identical structure for unknown agent", async () => {
    const sameProcessResult = await runAgentSameProcess({
      ...baseOpts,
      agents: [],
      agentName: "nonexistent",
    });

    const subprocessResult = await runAgentSubprocess({
      cwd: process.cwd(),
      agents: [],
      agentName: "nonexistent",
      task: "test",
      delegationMode: "spawn",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails,
    });

    assert.equal(sameProcessResult.exitCode, 1);
    assert.equal(subprocessResult.exitCode, 1);
    assert.equal(sameProcessResult.agent, subprocessResult.agent);
    assert.equal(sameProcessResult.agentSource, subprocessResult.agentSource);
  });
});
