import assert from "node:assert/strict";
import { test } from "node:test";
import { processJsonLine } from "../runner.js";
import {
  buildSubagentDetails,
  compactSingleResultForDurableDetails,
  emptyUsage,
  extractToolCalls,
  getDisplayItems,
  getFinalOutput,
} from "../types.js";
import { makeRunningResult as makeResult } from "./helpers/results.js";

test("JSONL message events reject non-object message payloads", () => {
  const result = makeResult();
  for (const type of ["message_end", "tool_result_end"]) {
    for (const message of [null, true, 12, "text", []]) {
      assert.equal(processJsonLine(JSON.stringify({ type, message }), result), false);
    }
  }
  assert.deepEqual(result.messages, []);
});

for (const toolName of ["subagents", "resume_subagents", "subagent"]) {
  test(`message_end clears matching nested progress for ${toolName}`, () => {
    const result = makeResult();
    const details = buildSubagentDetails("single", "spawn", null, []);
    result.liveNestedSubagents = { completed: details, running: details };
    const message = {
      role: "toolResult",
      toolName,
      toolCallId: "completed",
      content: [],
      details,
    };

    assert.equal(processJsonLine(JSON.stringify({ type: "message_end", message }), result), true);
    assert.equal(result.liveNestedSubagents.completed, undefined);
    assert.equal(result.liveNestedSubagents.running, details, "unrelated progress must survive");
    assert.deepEqual(result.messages, [message]);
  });
}

test("duplicate message_end still retires a stale nested snapshot", () => {
  const result = makeResult();
  const details = buildSubagentDetails("single", "spawn", null, []);
  const message = {
    role: "toolResult",
    toolName: "subagents",
    toolCallId: "completed",
    content: [],
  };
  result.messages.push(message);
  result.liveNestedSubagents = { completed: details };

  assert.equal(processJsonLine(JSON.stringify({ type: "message_end", message }), result), true);
  assert.equal(result.liveNestedSubagents.completed, undefined);
  assert.equal(result.messages.length, 1, "duplicate messages must not enter the transcript");
});

test("malformed usage cannot turn numeric totals into strings", () => {
  const result = makeResult();
  assert.equal(
    processJsonLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          usage: { input: "10", output: 3, cacheRead: {}, cost: { total: "1" } },
        },
      }),
      result,
    ),
    true,
  );
  assert.deepEqual(result.usage, { ...emptyUsage(), output: 3, turns: 1 });
});

test("tool events require string identities and normalize malformed arguments", () => {
  const result = makeResult();
  assert.equal(processJsonLine(JSON.stringify({ type: "tool_execution_start" }), result), false);
  assert.equal(result.liveToolExecutions, undefined);
  assert.equal(
    processJsonLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "read",
        args: null,
      }),
      result,
    ),
    true,
  );
  assert.deepEqual(result.liveToolExecutions?.["call-1"], { toolName: "read", args: {} });
});

test("message helpers skip malformed history and content entries", () => {
  const messages = [
    null,
    2,
    [],
    {
      role: "assistant",
      content: [null, 3, { type: "text", text: "answer" }, { type: "toolCall", name: "read", arguments: null }],
    },
  ];
  assert.equal(getFinalOutput(messages), "answer");
  assert.deepEqual(extractToolCalls(messages), { read: 1 });
  assert.deepEqual(getDisplayItems(messages), [
    { type: "text", text: "answer" },
    { type: "toolCall", name: "read", args: {} },
  ]);
});

test("durable compatibility fields remain hidden and read-only", () => {
  const result = makeResult();
  const compact = compactSingleResultForDurableDetails(result);
  const details = buildSubagentDetails("single", "spawn", null, [result]);
  for (const [object, field] of [
    [compact, "messages"],
    [details, "aggregatedUsage"],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(object, field);
    assert.equal(descriptor?.enumerable, false);
    assert.equal(descriptor?.writable, false);
    assert.equal(descriptor?.configurable, false);
    assert.equal(field in JSON.parse(JSON.stringify(object)), false);
  }
});
