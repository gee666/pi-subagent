import assert from "node:assert/strict";
import { test } from "node:test";
import { toolContext } from "./helpers/tool-context.js";
import { createLeadMessageTool, registerLeadMessageTool } from "../extension/lead-message-tool.js";
import {
  encodeLeadMessage,
  isLeadMessage,
  LEAD_MESSAGE_EVENT_TYPE,
  LEAD_MESSAGE_STDERR_PREFIX,
  MAX_LEAD_MESSAGE_CHARS,
  parseLeadMessageStderrLine,
} from "../runner/lead-message.js";

import { SUBAGENT_DEPTH_ENV } from "../runner/constants.js";

const ctx = toolContext({});

function setChildDepth(t: { after(fn: () => void): void }, value: string | undefined): void {
  const previous = process.env[SUBAGENT_DEPTH_ENV];
  if (value === undefined) delete process.env[SUBAGENT_DEPTH_ENV];
  else process.env[SUBAGENT_DEPTH_ENV] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[SUBAGENT_DEPTH_ENV];
    else process.env[SUBAGENT_DEPTH_ENV] = previous;
  });
}

test("lead message codec preserves text, escapes line breaks, and rejects malformed records", () => {
  const message = " findings 😀 終\nsecond line\r\n\u0000 ";
  const wire = encodeLeadMessage(message);
  assert.equal(wire.split("\n").length, 3);
  assert.deepEqual(parseLeadMessageStderrLine(wire.trim()), { type: LEAD_MESSAGE_EVENT_TYPE, message });
  assert.equal(parseLeadMessageStderrLine(JSON.stringify({ type: LEAD_MESSAGE_EVENT_TYPE, message })), undefined);
  for (const payload of ["{", "null", "[]", "{}", '{"type":"other","message":"hello"}']) {
    assert.equal(parseLeadMessageStderrLine(LEAD_MESSAGE_STDERR_PREFIX + payload), undefined);
  }
  for (const message of [null, 1, {}, "", " \n\t", "x".repeat(MAX_LEAD_MESSAGE_CHARS + 1)]) {
    assert.equal(isLeadMessage(message), false);
    assert.equal(
      parseLeadMessageStderrLine(
        LEAD_MESSAGE_STDERR_PREFIX + JSON.stringify({ type: LEAD_MESSAGE_EVENT_TYPE, message }),
      ),
      undefined,
    );
  }
  assert.ok(isLeadMessage("x".repeat(MAX_LEAD_MESSAGE_CHARS)));
  assert.throws(() => encodeLeadMessage(" "), /non-whitespace/);
  assert.throws(() => encodeLeadMessage("x".repeat(MAX_LEAD_MESSAGE_CHARS + 1)), /at most/);
});

test("registration exposes message_lead_agent without requiring delegation tools", () => {
  let registered = "";
  registerLeadMessageTool({
    registerTool: (tool) => {
      registered = tool.name;
    },
  });
  assert.equal(registered, "message_lead_agent");
});

test("message tool writes a single prefixed notification and returns after the local flush", async (t) => {
  setChildDepth(t, "1");
  const writes: string[] = [];
  let flushed: (() => void) | undefined;
  t.mock.method(process.stderr, "write", (line: string, callback: () => void) => {
    writes.push(line);
    flushed = callback;
    return true;
  });
  const tool = createLeadMessageTool();
  const promise = tool.execute("id", { message: "progress\n😀" }, undefined, undefined, ctx);
  assert.deepEqual(writes, [encodeLeadMessage("progress\n😀")]);
  assert.ok(flushed);
  flushed();
  const result = await promise;
  assert.equal(result.details, undefined);
  assert.deepEqual(result.content, [
    { type: "text", text: "Message queued for your immediate lead agent. No reply is awaited." },
  ]);
});

test("message tool rejects missing transport, invalid input, and pre-cancelled sends", async (t) => {
  setChildDepth(t, undefined);
  const write = t.mock.method(process.stderr, "write", () => true);
  const tool = createLeadMessageTool();
  const execute = (message: string, signal?: AbortSignal) => tool.execute("id", { message }, signal, undefined, ctx);
  await assert.rejects(execute("hello"), /No immediate lead/);
  for (const depth of ["0", "-1", "garbage", "1.5"]) {
    process.env[SUBAGENT_DEPTH_ENV] = depth;
    await assert.rejects(execute("hello"), /No immediate lead/);
  }
  process.env[SUBAGENT_DEPTH_ENV] = "1";
  await assert.rejects(execute(" \n"), /non-whitespace/);
  await assert.rejects(execute("x".repeat(MAX_LEAD_MESSAGE_CHARS + 1)), /at most/);
  await assert.rejects(execute("hello", AbortSignal.abort(new Error("cancelled"))), /cancelled/);
  assert.equal(write.mock.callCount(), 0);
});

test("message tool reports local write failures instead of claiming delivery", async (t) => {
  setChildDepth(t, "1");
  t.mock.method(process.stderr, "write", (_line: string, callback: (error: Error) => void) => {
    callback(new Error("pipe closed"));
    return false;
  });
  await assert.rejects(
    createLeadMessageTool().execute("id", { message: "hello" }, undefined, undefined, ctx),
    /pipe closed/,
  );
});
