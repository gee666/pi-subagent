/**
 * Tests for runner.ts utility functions.
 * - processJsonLine: JSON event parsing
 * - mapConcurrent: bounded parallel execution
 * - runAgent: error recovery (subprocess crash, spawn failure, etc.)
 */
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type SingleResult } from "../types.js";
import { processJsonLine } from "../runner.js";
import { mapConcurrent } from "../shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "test-agent",
    agentSource: "user",
    task: "do something",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    toolCalls: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// processJsonLine
// ---------------------------------------------------------------------------

describe("processJsonLine", () => {
  test("returns false for empty line", () => {
    const result = makeResult();
    assert.equal(processJsonLine("", result), false);
    assert.equal(processJsonLine("   ", result), false);
  });

  test("returns false for non-JSON line", () => {
    const result = makeResult();
    assert.equal(processJsonLine("not json", result), false);
    assert.equal(processJsonLine("Starting agent...", result), false);
  });

  test("returns false for invalid JSON (broken)", () => {
    const result = makeResult();
    // This is the error scenario from the bug report
    assert.equal(processJsonLine('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"value with missing end"}', result), false);
  });

  test("returns false for JSON that is not a recognized event type", () => {
    const result = makeResult();
    assert.equal(processJsonLine('{"type":"unknown_event","data":{}}', result), false);
  });

  test("ignores message_end without message field", () => {
    const result = makeResult();
    assert.equal(processJsonLine('{"type":"message_end"}', result), false);
  });

  test("processes message_end with assistant message", () => {
    const result = makeResult();
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
        model: "claude-3-5-sonnet",
        stopReason: "end_turn",
      },
    };
    const returned = processJsonLine(JSON.stringify(event), result);
    assert.equal(returned, true);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, "assistant");
    assert.equal(result.usage.input, 10);
    assert.equal(result.usage.output, 5);
    assert.equal(result.usage.turns, 1);
    assert.equal(result.model, "claude-3-5-sonnet");
    assert.equal(result.stopReason, "end_turn");
  });

  test("processes message_end with user message (no usage update)", () => {
    const result = makeResult();
    const event = {
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "task text" }],
      },
    };
    const returned = processJsonLine(JSON.stringify(event), result);
    assert.equal(returned, true);
    assert.equal(result.messages.length, 1);
    assert.equal(result.usage.turns, 0); // no usage added for user messages
  });

  test("processes tool_result_end event", () => {
    const result = makeResult();
    const event = {
      type: "tool_result_end",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "tc1",
        content: [{ type: "text", text: "output" }],
      },
    };
    const returned = processJsonLine(JSON.stringify(event), result);
    assert.equal(returned, true);
    assert.equal(result.messages.length, 1);
  });

  test("accumulates usage across multiple assistant messages", () => {
    const result = makeResult();
    const msg1 = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      },
    };
    const msg2 = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 20, output: 10, cacheRead: 2, cacheWrite: 1, totalTokens: 33 },
      },
    };
    processJsonLine(JSON.stringify(msg1), result);
    processJsonLine(JSON.stringify(msg2), result);
    assert.equal(result.usage.input, 30);
    assert.equal(result.usage.output, 15);
    assert.equal(result.usage.turns, 2);
  });

  test("handles malformed JSON at high character position (bug reproduction)", () => {
    // Simulate the reported bug: JSON parse error at position 1178
    // The extension should NOT throw; processJsonLine should silently return false
    const result = makeResult();
    const longTaskText = "A".repeat(1100); // Make the JSON long enough to hit position 1178
    const malformedJson = `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${longTaskText}"}] BROKEN HERE`;
    assert.doesNotThrow(() => {
      const returned = processJsonLine(malformedJson, result);
      assert.equal(returned, false);
    });
    // Result should be unchanged
    assert.equal(result.messages.length, 0);
  });

  test("handles JSON with embedded newlines in strings", () => {
    // JSON.stringify properly escapes newlines, so parsing should work
    const result = makeResult();
    const textWithNewlines = "line1\nline2\nline3";
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: textWithNewlines }],
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
      },
    };
    const returned = processJsonLine(JSON.stringify(event), result);
    assert.equal(returned, true);
    assert.equal(result.messages.length, 1);
  });

  test("handles JSON with special characters in task text", () => {
    const result = makeResult();
    const specialChars = 'Fix bug in "component" with {key: "value"} and <tag> & \'quote\'';
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: specialChars }],
        usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
      },
    };
    const returned = processJsonLine(JSON.stringify(event), result);
    assert.equal(returned, true);
  });

  test("handles cost field in usage", () => {
    const result = makeResult();
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165, cost: { total: 0.123 } },
      },
    };
    processJsonLine(JSON.stringify(event), result);
    assert.ok(Math.abs(result.usage.cost - 0.123) < 0.0001);
  });
});

// ---------------------------------------------------------------------------
// mapConcurrent
// ---------------------------------------------------------------------------

describe("mapConcurrent", () => {
  test("returns empty array for empty input", async () => {
    const results = await mapConcurrent([], 4, async (x) => x);
    assert.deepEqual(results, []);
  });

  test("processes all items", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapConcurrent(items, 2, async (x) => x * 2);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
  });

  test("respects order of results", async () => {
    const items = [3, 1, 4, 1, 5];
    const results = await mapConcurrent(items, 3, async (x) => x * 10);
    assert.deepEqual(results, [30, 10, 40, 10, 50]);
  });

  test("runs with concurrency 1 (sequential)", async () => {
    const order: number[] = [];
    const items = [0, 1, 2, 3];
    await mapConcurrent(items, 1, async (x, i) => {
      order.push(i);
      return x;
    });
    assert.deepEqual(order, [0, 1, 2, 3]);
  });

  test("runs with high concurrency (all at once)", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await mapConcurrent(items, 100, async (x) => x + 1);
    assert.deepEqual(results, Array.from({ length: 10 }, (_, i) => i + 1));
  });

  test("actually runs tasks concurrently", async () => {
    // With concurrency=2, tasks should overlap
    const startTimes: number[] = [];
    const items = [0, 1, 2, 3];
    const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    await mapConcurrent(items, 2, async (x, i) => {
      startTimes.push(Date.now());
      await delay(20);
      return x;
    });

    // Items 0 and 1 should start at roughly the same time
    assert.equal(startTimes.length, 4);
    const gap01 = Math.abs(startTimes[1] - startTimes[0]);
    const gap12 = Math.abs(startTimes[2] - startTimes[1]);
    assert.ok(gap01 < 15, `Items 0 and 1 should start concurrently (gap: ${gap01}ms)`);
    assert.ok(gap12 >= 10, `Item 2 should wait for a slot (gap: ${gap12}ms)`);
  });

  test("propagates errors from tasks", async () => {
    const items = [1, 2, 3];
    await assert.rejects(
      mapConcurrent(items, 2, async (x) => {
        if (x === 2) throw new Error("task failed");
        return x;
      }),
      /task failed/
    );
  });
});

// ---------------------------------------------------------------------------
// runAgent error handling
// ---------------------------------------------------------------------------

describe("runAgent resilience", () => {
  test("returns error result for unknown agent", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const result = await runAgent({
      cwd: "/tmp",
      agents: [],
      agentName: "nonexistent",
      task: "do something",
      delegationMode: "spawn",
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

  test("startup timeout kills a hung process and returns a result", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");

    // Use a fake agent
    const fakeAgent = {
      name: "fake",
      description: "fake agent",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/agent.md",
    };

    // Use a short startup timeout so the extension kills the hung
    // process itself — no external abort needed.
    const origTimeout = process.env.PI_SUBAGENT_STARTUP_TIMEOUT;
    process.env.PI_SUBAGENT_STARTUP_TIMEOUT = "3000";

    let result;
    try {
      result = await runAgent({
        cwd: "/tmp",
        agents: [fakeAgent],
        agentName: "fake",
        task: "do something",
        delegationMode: "spawn",
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
    } finally {
      if (origTimeout === undefined) delete process.env.PI_SUBAGENT_STARTUP_TIMEOUT;
      else process.env.PI_SUBAGENT_STARTUP_TIMEOUT = origTimeout;
    }

    // The extension must have killed the process and returned a valid
    // SingleResult (not hung forever).
    assert.ok(typeof result.exitCode === "number");
    assert.ok(typeof result.stderr === "string");
    assert.ok(Array.isArray(result.messages));
    assert.ok(result.stderr.includes("startup timeout"));
  });

  test("handles fork mode with missing snapshot gracefully", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");

    const fakeAgent = {
      name: "fake",
      description: "fake",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/agent.md",
    };

    const result = await runAgent({
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake",
      task: "task",
      delegationMode: "fork",
      forkSessionSnapshotJsonl: "",  // empty — should fail gracefully
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => ({
        mode: "single",
        delegationMode: "fork",
        projectAgentsDir: null,
        results,
        aggregatedUsage: emptyUsage(),
        aggregatedToolCalls: {},
        usageTree: [],
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.errorMessage?.includes("fork mode"));
  });
});
