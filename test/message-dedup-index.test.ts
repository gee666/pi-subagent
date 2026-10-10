import assert from "node:assert/strict";
import { test } from "node:test";
import { processRpcEvent } from "../runner/events.js";
import { appendUniqueMessage } from "../runner/message-index.js";
import type { TranscriptMessage } from "../types/transcript.js";
import { makeRunningResult } from "./helpers/results.js";
import { buildSubagentDetails } from "../types.js";

function oldKey(message: TranscriptMessage): string {
  if (typeof message.id === "string") return `id:${message.id}`;
  return JSON.stringify({
    role: message.role,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    usage: message.usage,
  });
}

test("fingerprint dedup preserves the historical equality projection and JSON ordering", () => {
  const base: TranscriptMessage = {
    role: "assistant",
    provider: "provider",
    model: "model",
    stopReason: "stop",
    content: [{ type: "text", text: "answer" }],
    usage: { input: 1, output: 2 },
  };
  const candidates: TranscriptMessage[] = [
    base,
    { ...base, timestamp: 100, details: { changed: true }, api: "other", errorMessage: "ignored", isError: true },
    { ...base, role: "custom" },
    { ...base, provider: "other" },
    { ...base, model: "other" },
    { ...base, stopReason: "error" },
    { ...base, toolCallId: "call" },
    { ...base, toolName: "tool" },
    { ...base, content: [{ type: "text", text: "other" }] },
    { ...base, content: [{ text: "answer", type: "text" }] },
    { ...base, usage: { output: 2, input: 1 } },
    { ...base, usage: { input: 1, output: 3 } },
    { ...base, id: "same-id" },
    { role: "user", id: "same-id", content: "different content" },
    { ...base, id: "" },
    { role: "custom", id: "", content: "different content" },
    { role: "user" },
    { role: "user", content: undefined },
    { role: "user", content: null },
    { role: "user", content: "\ud800" },
    { role: "user", content: "\ud801" },
    { role: "user", id: "\ud800" },
    { role: "user", id: "\ud801" },
    { role: "user", id: "\ufffd" },
    ...[...Array(20)].map(() => ({ ...base })),
  ];
  const expected: TranscriptMessage[] = [];
  const result = makeRunningResult();
  for (const message of candidates) {
    if (!expected.some((existing) => oldKey(existing) === oldKey(message))) expected.push(message);
    assert.equal(processRpcEvent({ type: "message_end", message }, result), true);
    assert.deepEqual(result.messages, expected);
  }
  assert.equal(result.usage.turns, expected.filter((message) => message.role === "assistant").length);
});

test("resumed histories, external appends and replacement arrays are indexed", () => {
  const first = { role: "user", content: "resumed" };
  const result = makeRunningResult({ messages: [first] });
  processRpcEvent({ type: "message_end", message: { ...first } }, result);
  assert.equal(result.messages.length, 1);

  const second = { role: "user", content: "external" };
  const third = { role: "user", content: "external too" };
  result.messages.push(second, third);
  processRpcEvent({ type: "message_end", message: { ...third } }, result);
  processRpcEvent({ type: "message_end", message: { ...second } }, result);
  assert.deepEqual(result.messages, [first, second, third]);

  result.messages = [...result.messages];
  processRpcEvent({ type: "message_end", message: { ...first } }, result);
  assert.equal(result.messages.length, 3);
  result.messages = [];
  processRpcEvent({ type: "message_end", message: first }, result);
  assert.deepEqual(result.messages, [first]);
});

test("a shortened history rebuilds its fingerprint index", () => {
  const messages: TranscriptMessage[] = [];
  const first = { role: "user", content: "first" };
  const second = { role: "user", content: "second" };
  assert.equal(appendUniqueMessage(messages, first), true);
  assert.equal(appendUniqueMessage(messages, second), true);
  messages.length = 1;
  assert.equal(appendUniqueMessage(messages, second), true);
  assert.deepEqual(messages, [first, second]);
});

test("legacy and current duplicate events share the index and still retire nested progress", () => {
  const result = makeRunningResult();
  const details = buildSubagentDetails("single", "spawn", null, []);
  const message = { role: "toolResult", toolName: "subagents", toolCallId: "call", content: [] };
  for (const type of ["tool_result_end", "message_end", "tool_result_end"]) {
    result.liveNestedSubagents = { call: details };
    assert.equal(processRpcEvent({ type, message: { ...message } }, result), true);
    assert.equal(result.messages.length, 1);
    assert.equal(result.liveNestedSubagents.call, undefined);
  }
});

test("distinct append-only messages serialize once each, including resumed history", () => {
  let serialized = 0;
  const message = (id: number): TranscriptMessage => ({
    role: "user",
    content: {
      toJSON() {
        serialized++;
        return `message-${id}-${"x".repeat(4096)}`;
      },
    },
  });
  const result = makeRunningResult({ messages: Array.from({ length: 200 }, (_, id) => message(id)) });
  for (let id = 200; id < 600; id++) processRpcEvent({ type: "message_end", message: message(id) }, result);
  assert.equal(result.messages.length, 600);
  assert.equal(serialized, 600, "no previous message should be serialized again for distinct additions");
  processRpcEvent({ type: "message_end", message: message(599) }, result);
  assert.equal(result.messages.length, 600);
  assert.equal(serialized, 602, "duplicates compare only their matching fingerprint bucket");
});

test("id equality does not serialize content and the index is absent from durable JSON", () => {
  const content = {
    toJSON: () => {
      throw new Error("content must not be serialized for id equality");
    },
  };
  const result = makeRunningResult();
  processRpcEvent({ type: "message_end", message: { role: "user", id: "large".repeat(10000), content } }, result);
  processRpcEvent({ type: "message_end", message: { role: "custom", id: "large".repeat(10000), content } }, result);
  assert.equal(result.messages.length, 1);
  result.messages[0].content = "serializable";
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(result))), Object.keys(result));
  assert.deepEqual(Object.keys(result.messages), ["0"]);
});
