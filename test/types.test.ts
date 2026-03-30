/**
 * Unit tests for types.ts utility functions.
 * These are pure functions with no external dependencies.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  emptyUsage,
  aggregateUsage,
  addUsage,
  mergeToolCalls,
  extractToolCalls,
  getFinalOutput,
  getDisplayItems,
  isResultError,
  isSubagentDetails,
  buildSubagentDetails,
  getNestedSubagentResults,
  getNestedSubagentErrorSummary,
  type SingleResult,
  type UsageStats,
  type ToolCallCounts,
  type SubagentDetails,
} from "../types.js";
import type { Message } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "test-agent",
    agentSource: "user",
    task: "do something",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    toolCalls: {},
    ...overrides,
  };
}

function makeTextMessage(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  } as unknown as Message;
}

function makeToolCallMessage(toolName: string, args: Record<string, unknown> = {}): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", name: toolName, arguments: args, toolCallId: "tc1" }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  } as unknown as Message;
}

function makeToolResultMessage(toolName: string, details: unknown, isError = false): Message {
  return {
    role: "toolResult",
    toolName,
    toolCallId: "tc1",
    content: [{ type: "text", text: "result" }],
    details,
    isError,
  } as unknown as Message;
}

// ---------------------------------------------------------------------------
// emptyUsage
// ---------------------------------------------------------------------------

describe("emptyUsage", () => {
  test("returns zero-valued stats", () => {
    const u = emptyUsage();
    assert.equal(u.input, 0);
    assert.equal(u.output, 0);
    assert.equal(u.cacheRead, 0);
    assert.equal(u.cacheWrite, 0);
    assert.equal(u.cost, 0);
    assert.equal(u.contextTokens, 0);
    assert.equal(u.turns, 0);
  });

  test("returns a new object each time", () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.input = 999;
    assert.equal(b.input, 0);
  });
});

// ---------------------------------------------------------------------------
// aggregateUsage
// ---------------------------------------------------------------------------

describe("aggregateUsage", () => {
  test("sums across results", () => {
    const r1 = makeResult({ usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01, contextTokens: 0, turns: 1 } });
    const r2 = makeResult({ usage: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2, cost: 0.02, contextTokens: 0, turns: 2 } });
    const total = aggregateUsage([r1, r2]);
    assert.equal(total.input, 30);
    assert.equal(total.output, 15);
    assert.equal(total.cacheRead, 6);
    assert.equal(total.cacheWrite, 3);
    assert.equal(Math.round(total.cost * 1000), 30); // 0.03
    assert.equal(total.turns, 3);
  });

  test("returns zeros for empty array", () => {
    const total = aggregateUsage([]);
    assert.deepEqual(total, emptyUsage());
  });
});

// ---------------------------------------------------------------------------
// addUsage
// ---------------------------------------------------------------------------

describe("addUsage", () => {
  test("adds delta into total in-place", () => {
    const total = emptyUsage();
    const delta: UsageStats = { input: 5, output: 3, cacheRead: 1, cacheWrite: 0, cost: 0.005, contextTokens: 100, turns: 1 };
    addUsage(total, delta);
    assert.equal(total.input, 5);
    assert.equal(total.output, 3);
    assert.equal(total.turns, 1);
  });

  test("accumulates multiple deltas", () => {
    const total = emptyUsage();
    addUsage(total, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
    addUsage(total, { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 });
    assert.equal(total.input, 30);
    assert.equal(total.turns, 3);
  });
});

// ---------------------------------------------------------------------------
// mergeToolCalls
// ---------------------------------------------------------------------------

describe("mergeToolCalls", () => {
  test("merges counts into target", () => {
    const target: ToolCallCounts = { bash: 2 };
    mergeToolCalls(target, { bash: 3, read: 1 });
    assert.equal(target.bash, 5);
    assert.equal(target.read, 1);
  });

  test("handles empty source", () => {
    const target: ToolCallCounts = { bash: 2 };
    mergeToolCalls(target, {});
    assert.equal(target.bash, 2);
  });

  test("handles empty target and source", () => {
    const target: ToolCallCounts = {};
    mergeToolCalls(target, {});
    assert.deepEqual(target, {});
  });

  test("sets new keys from source", () => {
    const target: ToolCallCounts = {};
    mergeToolCalls(target, { newTool: 5 });
    assert.equal(target.newTool, 5);
  });
});

// ---------------------------------------------------------------------------
// extractToolCalls
// ---------------------------------------------------------------------------

describe("extractToolCalls", () => {
  test("counts tool calls from assistant messages", () => {
    const msg1 = makeToolCallMessage("bash");
    const msg2 = makeToolCallMessage("bash");
    const msg3 = makeToolCallMessage("read");
    const counts = extractToolCalls([msg1, msg2, msg3]);
    assert.equal(counts.bash, 2);
    assert.equal(counts.read, 1);
  });

  test("ignores non-assistant messages", () => {
    const toolResultMsg = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "tc1",
      content: [],
    } as unknown as Message;
    const counts = extractToolCalls([toolResultMsg]);
    assert.deepEqual(counts, {});
  });

  test("returns empty for no messages", () => {
    const counts = extractToolCalls([]);
    assert.deepEqual(counts, {});
  });

  test("handles messages with no tool calls", () => {
    const msg = makeTextMessage("hello");
    const counts = extractToolCalls([msg]);
    assert.deepEqual(counts, {});
  });

  test("uses 'unknown' for tool calls without name", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "tc1" }], // no name
    } as unknown as Message;
    const counts = extractToolCalls([msg]);
    assert.equal(counts.unknown, 1);
  });
});

// ---------------------------------------------------------------------------
// getFinalOutput
// ---------------------------------------------------------------------------

describe("getFinalOutput", () => {
  test("returns last assistant text", () => {
    const msgs = [
      makeTextMessage("first"),
      makeTextMessage("second"),
    ];
    assert.equal(getFinalOutput(msgs), "second");
  });

  test("returns empty string for no messages", () => {
    assert.equal(getFinalOutput([]), "");
  });

  test("skips non-text parts and non-assistant messages", () => {
    const toolCallMsg = makeToolCallMessage("bash");
    const assistantTextMsg = makeTextMessage("result text");
    assert.equal(getFinalOutput([toolCallMsg, assistantTextMsg]), "result text");
  });

  test("skips toolResult messages", () => {
    const msg = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: "tc1",
      content: [{ type: "text", text: "should not appear" }],
    } as unknown as Message;
    assert.equal(getFinalOutput([msg]), "");
  });
});

// ---------------------------------------------------------------------------
// getDisplayItems
// ---------------------------------------------------------------------------

describe("getDisplayItems", () => {
  test("collects text and tool calls from assistant messages", () => {
    const msgs = [
      makeTextMessage("hello"),
      makeToolCallMessage("bash", { command: "ls" }),
    ];
    const items = getDisplayItems(msgs);
    assert.equal(items.length, 2);
    assert.equal(items[0].type, "text");
    assert.equal((items[0] as any).text, "hello");
    assert.equal(items[1].type, "toolCall");
    assert.equal((items[1] as any).name, "bash");
  });

  test("returns empty for no messages", () => {
    assert.deepEqual(getDisplayItems([]), []);
  });
});

// ---------------------------------------------------------------------------
// isResultError
// ---------------------------------------------------------------------------

describe("isResultError", () => {
  test("returns false for exit code 0", () => {
    assert.equal(isResultError(makeResult({ exitCode: 0 })), false);
  });

  test("returns true for exit code > 0", () => {
    assert.equal(isResultError(makeResult({ exitCode: 1 })), true);
    assert.equal(isResultError(makeResult({ exitCode: 130 })), true);
  });

  test("returns true for stop reason 'error'", () => {
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "error" })), true);
  });

  test("returns true for stop reason 'aborted'", () => {
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "aborted" })), true);
  });

  test("returns false for other stop reasons", () => {
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "end_turn" })), false);
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "max_tokens" })), false);
  });
});

// ---------------------------------------------------------------------------
// isSubagentDetails
// ---------------------------------------------------------------------------

describe("isSubagentDetails", () => {
  test("returns true for valid SubagentDetails", () => {
    const d = buildSubagentDetails("single", "spawn", null, []);
    assert.equal(isSubagentDetails(d), true);
  });

  test("returns false for null", () => {
    assert.equal(isSubagentDetails(null), false);
  });

  test("returns false for non-object", () => {
    assert.equal(isSubagentDetails("string"), false);
    assert.equal(isSubagentDetails(42), false);
    assert.equal(isSubagentDetails(undefined), false);
  });

  test("returns false if mode is wrong", () => {
    assert.equal(isSubagentDetails({ mode: "invalid", delegationMode: "spawn", results: [] }), false);
  });

  test("returns false if delegationMode is wrong", () => {
    assert.equal(isSubagentDetails({ mode: "single", delegationMode: "invalid", results: [] }), false);
  });

  test("returns false if results is not array", () => {
    assert.equal(isSubagentDetails({ mode: "single", delegationMode: "spawn", results: null }), false);
  });
});

// ---------------------------------------------------------------------------
// buildSubagentDetails
// ---------------------------------------------------------------------------

describe("buildSubagentDetails", () => {
  test("builds correct structure for empty results", () => {
    const d = buildSubagentDetails("single", "spawn", "/project/agents", []);
    assert.equal(d.mode, "single");
    assert.equal(d.delegationMode, "spawn");
    assert.equal(d.projectAgentsDir, "/project/agents");
    assert.deepEqual(d.results, []);
    assert.deepEqual(d.aggregatedUsage, emptyUsage());
    assert.deepEqual(d.aggregatedToolCalls, {});
    assert.deepEqual(d.usageTree, []);
  });

  test("aggregates usage across results", () => {
    const r1 = makeResult({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 } });
    const r2 = makeResult({ usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 2 } });
    const d = buildSubagentDetails("parallel", "spawn", null, [r1, r2]);
    assert.equal(d.aggregatedUsage.input, 30);
    assert.equal(d.aggregatedUsage.turns, 3);
  });

  test("aggregates tool calls across results", () => {
    const r1 = makeResult({ toolCalls: { bash: 2, read: 1 } });
    const r2 = makeResult({ toolCalls: { bash: 1, write: 3 } });
    const d = buildSubagentDetails("parallel", "spawn", null, [r1, r2]);
    assert.equal(d.aggregatedToolCalls.bash, 3);
    assert.equal(d.aggregatedToolCalls.read, 1);
    assert.equal(d.aggregatedToolCalls.write, 3);
  });

  test("builds usage tree nodes", () => {
    const r = makeResult({ agent: "my-agent" });
    const d = buildSubagentDetails("single", "spawn", null, [r]);
    assert.equal(d.usageTree.length, 1);
    assert.equal(d.usageTree[0].agent, "my-agent");
  });
});

// ---------------------------------------------------------------------------
// getNestedSubagentResults
// ---------------------------------------------------------------------------

describe("getNestedSubagentResults", () => {
  test("returns empty for no tool results", () => {
    const msgs = [makeTextMessage("hello")];
    assert.deepEqual(getNestedSubagentResults(msgs), []);
  });

  test("returns empty for tool results that are not subagent", () => {
    const msg = makeToolResultMessage("bash", null);
    assert.deepEqual(getNestedSubagentResults([msg]), []);
  });

  test("returns empty for subagent results without valid details", () => {
    const msg = makeToolResultMessage("subagent", { invalid: true });
    assert.deepEqual(getNestedSubagentResults([msg]), []);
  });

  test("returns nested results for valid subagent tool results", () => {
    const innerDetails = buildSubagentDetails("single", "spawn", null, [makeResult()]);
    const msg = makeToolResultMessage("subagent", innerDetails, false);
    const results = getNestedSubagentResults([msg]);
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, false);
    assert.equal(results[0].toolCallId, "tc1");
  });
});

// ---------------------------------------------------------------------------
// getNestedSubagentErrorSummary
// ---------------------------------------------------------------------------

describe("getNestedSubagentErrorSummary", () => {
  test("returns null when no nested failures", () => {
    const innerDetails = buildSubagentDetails("single", "spawn", null, [makeResult({ exitCode: 0 })]);
    const msg = makeToolResultMessage("subagent", innerDetails, false);
    assert.equal(getNestedSubagentErrorSummary([msg]), null);
  });

  test("returns null when no subagent tool results", () => {
    const msgs = [makeTextMessage("hello")];
    assert.equal(getNestedSubagentErrorSummary(msgs), null);
  });

  test("returns summary when nested agent failed", () => {
    const failedResult = makeResult({ exitCode: 1, agent: "failing-agent", errorMessage: "it broke" });
    const innerDetails = buildSubagentDetails("single", "spawn", null, [failedResult]);
    const msg = makeToolResultMessage("subagent", innerDetails, true);
    const summary = getNestedSubagentErrorSummary([msg]);
    assert.ok(summary !== null);
    assert.ok(summary!.includes("failing-agent"));
    assert.ok(summary!.includes("it broke"));
  });

  test("returns null when outer isError=false even if inner result failed", () => {
    // getNestedSubagentErrorSummary only processes results where isError=true on the tool result msg
    const failedResult = makeResult({ exitCode: 1, agent: "failing-agent", errorMessage: "it broke" });
    const innerDetails = buildSubagentDetails("single", "spawn", null, [failedResult]);
    const msg = makeToolResultMessage("subagent", innerDetails, false); // isError=false
    const summary = getNestedSubagentErrorSummary([msg]);
    assert.equal(summary, null);
  });
});
