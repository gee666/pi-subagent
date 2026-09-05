import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage } from "../types.js";
import { makeRunningResult as makeResult } from "./helpers/results.js";

function hungPiMockOptions(timeoutMs = 50) {
  return {
    startupTimeoutMsOverride: timeoutMs,
    piCommandOverride: {
      command: process.execPath,
      argsPrefix: ["-e", "setInterval(() => {}, 1000)", "--"],
    },
  };
}

describe("runAgent resilience", () => {
  test("returns error result for unknown agent", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const result = await runAgent({
      cwd: "/tmp",
      agents: [],
      agentName: "nonexistent",
      task: "do something",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => ({
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results,
        aggregatedUsage: emptyUsage(),
        aggregatedToolCalls: {},
        usageTree: [],
      }),
    });
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes("nonexistent"));
    assert.ok(result.stderr.includes("Unknown agent"));
  });

  test("missing unstarted resume session directory is treated as a fresh run", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const fakeAgent = {
      name: "fake",
      description: "fake agent",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/agent.md",
    };

    const result = await runAgent({
      ...hungPiMockOptions(),
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake",
      task: "do something",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      resumeSession: true,
      sessionDir: "/tmp/pi-subagent-missing-session-dir-for-test",
      initialResult: {
        agent: "fake",
        agentSource: "user",
        task: "do something",
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: emptyUsage(),
        toolCalls: {},
        completedTurns: 0,
        turnInProgress: false,
        liveLog: [],
        sessionDir: "/tmp/pi-subagent-missing-session-dir-for-test",
      },
      makeDetails: (results) => ({
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results,
        aggregatedUsage: emptyUsage(),
        aggregatedToolCalls: {},
        usageTree: [],
      }),
    });

    assert.match(result.stderr, /startup timeout/);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stopReason, "error");
    assert.doesNotMatch(result.stderr, /session directory does not exist/);
  });

  test("missing started resume session directory is treated as a fresh run", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const fakeAgent = {
      name: "fake",
      description: "fake agent",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/agent.md",
    };

    const result = await runAgent({
      ...hungPiMockOptions(),
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake",
      task: "do something",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      resumeSession: true,
      sessionDir: "/tmp/pi-subagent-missing-started-session-dir-for-test",
      initialResult: {
        agent: "fake",
        agentSource: "user",
        task: "do something",
        exitCode: -1,
        messages: [{ role: "assistant", content: [{ type: "text", text: "started" }] }],
        stderr: "",
        usage: emptyUsage(),
        toolCalls: {},
        completedTurns: 1,
        turnInProgress: false,
        liveLog: [],
        sessionDir: "/tmp/pi-subagent-missing-started-session-dir-for-test",
      },
      makeDetails: (results) => ({
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results,
        aggregatedUsage: emptyUsage(),
        aggregatedToolCalls: {},
        usageTree: [],
      }),
    });

    assert.match(result.stderr, /startup timeout/);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stopReason, "error");
    assert.doesNotMatch(result.stderr, /session directory does not exist/);
  });

  test("resume subprocess that exits without new messages is an error", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const fakeAgent = {
      name: "fake",
      description: "fake agent",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/agent.md",
    };

    const result = await runAgent({
      piCommandOverride: {
        command: process.execPath,
        argsPrefix: ["-e", "process.exit(0)", "--"],
      },
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake",
      task: "continue work",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      resumeSession: true,
      sessionDir: "/tmp",
      initialResult: makeResult({
        agent: "fake",
        agentSource: "user",
        task: "continue work",
        messages: [{ role: "assistant", content: [{ type: "text", text: "started" }] }],
        sessionDir: "/tmp",
      }),
      makeDetails: (results) => ({
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results,
        aggregatedUsage: emptyUsage(),
        aggregatedToolCalls: {},
        usageTree: [],
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /before agent_settled/i);
  });

  test("startup timeout kills a hung process and returns a result", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");

    const fakeAgent = {
      name: "fake",
      description: "fake agent",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/agent.md",
    };

    const result = await runAgent({
      ...hungPiMockOptions(),
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake",
      task: "do something",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => ({
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results,
        aggregatedUsage: emptyUsage(),
        aggregatedToolCalls: {},
        usageTree: [],
      }),
    });

    assert.ok(typeof result.exitCode === "number");
    assert.ok(typeof result.stderr === "string");
    assert.ok(Array.isArray(result.messages));
    assert.ok(result.stderr.includes("startup timeout"));
    assert.equal(result.exitCode, 1);
    assert.equal(result.stopReason, "error");
  });
});
