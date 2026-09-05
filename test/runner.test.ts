import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage } from "../types.js";
import { processJsonLine } from "../runner.js";
import { makeRunningResult as makeResult } from "./helpers/results.js";

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
    assert.equal(
      processJsonLine(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"value with missing end"}',
        result,
      ),
      false,
    );
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

  test("processes subagent_progress as transient live nested details", () => {
    const result = makeResult();
    const event = {
      type: "subagent_progress",
      toolCallId: "nested-call-1",
      details: {
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results: [
          {
            agent: "code-writer",
            agentSource: "builtin",
            task: "write",
            exitCode: -1,
            messages: [],
            stderr: "",
            usage: emptyUsage(),
            toolCalls: {},
            completedTurns: 1,
            turnInProgress: true,
            liveLog: [{ kind: "tool_start", toolName: "edit", args: { path: "/tmp/file" } }],
          },
        ],
      },
    };

    const returned = processJsonLine(JSON.stringify(event), result);

    assert.equal(returned, true);
    assert.equal(result.messages.length, 0, "progress must not enter durable message history");
    assert.equal(result.liveNestedSubagents?.["nested-call-1"]?.results[0]?.agent, "code-writer");
  });

  test("final subagent tool_result_end clears matching transient live nested details", () => {
    const result = makeResult({
      liveNestedSubagents: {
        "nested-call-1": {
          mode: "single",
          delegationMode: "spawn",
          projectAgentsDir: null,
          results: [],
          aggregatedUsage: emptyUsage(),
          aggregatedToolCalls: {},
          usageTree: [],
        },
      },
    });
    const event = {
      type: "tool_result_end",
      message: {
        role: "toolResult",
        toolName: "subagent",
        toolCallId: "nested-call-1",
        isError: false,
        content: [{ type: "text", text: "done" }],
        details: {
          mode: "single",
          delegationMode: "spawn",
          projectAgentsDir: null,
          results: [],
          aggregatedUsage: emptyUsage(),
          aggregatedToolCalls: {},
          usageTree: [],
        },
      },
    };

    assert.equal(processJsonLine(JSON.stringify(event), result), true);
    assert.equal(result.liveNestedSubagents?.["nested-call-1"], undefined);
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
