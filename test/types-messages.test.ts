import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extractToolCalls,
  getFinalOutput,
  getDisplayItems,
  buildSubagentDetails,
  getNestedSubagentResults,
  getNestedSubagentErrorSummary,
} from "../types.js";
import { makeResult, makeTextMessage, makeToolCallMessage, makeToolResultMessage } from "./helpers/results.js";

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
    };
    const counts = extractToolCalls([toolResultMsg]);
    assert.deepEqual(counts, {});
  });

  test("returns empty for no messages", () => {
    const counts = extractToolCalls([]);
    assert.deepEqual(counts, {});
  });

  test("returns empty for malformed non-array messages", () => {
    const counts = extractToolCalls({ length: 1 });
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
    };
    const counts = extractToolCalls([msg]);
    assert.equal(counts.unknown, 1);
  });
});

// ---------------------------------------------------------------------------
// getFinalOutput
// ---------------------------------------------------------------------------

describe("getFinalOutput", () => {
  test("returns last assistant text", () => {
    const msgs = [makeTextMessage("first"), makeTextMessage("second")];
    assert.equal(getFinalOutput(msgs), "second");
  });

  test("returns last text part in the last assistant message", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "draft" },
        { type: "toolCall", name: "bash", arguments: {} },
        { type: "text", text: "final" },
      ],
    };
    assert.equal(getFinalOutput([msg]), "final");
  });

  test("returns empty string for no messages", () => {
    assert.equal(getFinalOutput([]), "");
  });

  test("returns fallback for malformed non-array messages", () => {
    assert.equal(getFinalOutput({ bad: true }, "cached final"), "cached final");
  });

  test("returns fallback when compact durable details omit transcript text", () => {
    assert.equal(getFinalOutput([], "cached final"), "cached final");
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
    };
    assert.equal(getFinalOutput([msg]), "");
  });
});

// ---------------------------------------------------------------------------
// getDisplayItems
// ---------------------------------------------------------------------------

describe("getDisplayItems", () => {
  test("collects text and tool calls from assistant messages", () => {
    const msgs = [makeTextMessage("hello"), makeToolCallMessage("bash", { command: "ls" })];
    const items = getDisplayItems(msgs);
    assert.equal(items.length, 2);
    assert.ok(items[0].type === "text");
    assert.equal(items[0].text, "hello");
    assert.ok(items[1].type === "toolCall");
    assert.equal(items[1].name, "bash");
  });

  test("returns empty for no messages", () => {
    assert.deepEqual(getDisplayItems([]), []);
  });

  test("returns empty for malformed non-array messages", () => {
    assert.deepEqual(getDisplayItems({ bad: true }), []);
  });
});

describe("getNestedSubagentResults", () => {
  test("returns empty for no tool results", () => {
    const msgs = [makeTextMessage("hello")];
    assert.deepEqual(getNestedSubagentResults(msgs), []);
  });

  test("returns empty for malformed non-array messages", () => {
    assert.deepEqual(getNestedSubagentResults({ bad: true }), []);
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
    assert.ok(summary.includes("failing-agent"));
    assert.ok(summary.includes("it broke"));
  });

  test("detects failed children even when an older outer result says isError=false", () => {
    const failedResult = makeResult({ exitCode: 1, agent: "failing-agent", errorMessage: "it broke" });
    const innerDetails = buildSubagentDetails("single", "spawn", null, [failedResult]);
    const msg = makeToolResultMessage("subagent", innerDetails, false);
    const summary = getNestedSubagentErrorSummary([msg]);
    assert.match(summary ?? "", /failing-agent.*it broke/);
  });
});
