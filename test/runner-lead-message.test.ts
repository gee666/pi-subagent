import assert from "node:assert/strict";
import { test } from "node:test";
import { runAttempt } from "../runner/attempt.js";
import type { AttemptState } from "../runner/attempt-state.js";
import type { RunAgentOptions } from "../runner/options.js";
import { createProtocolHandler } from "../runner/protocol.js";
import { encodeLeadMessage, LEAD_MESSAGE_EVENT_TYPE, LEAD_MESSAGE_STDERR_PREFIX } from "../runner/lead-message.js";
import { makeRunningResult } from "./helpers/results.js";

function options(code: string, onLeadMessage?: RunAgentOptions["onLeadMessage"]): RunAgentOptions {
  return {
    cwd: process.cwd(),
    agents: [],
    agentName: "test-agent",
    task: "test child notifications",
    parentDepth: 0,
    parentAgentStack: [],
    maxDepth: 3,
    preventCycles: false,
    settings: {},
    startupTimeoutMsOverride: 45000,
    idleTimeoutMsOverride: 0,
    terminationTimeoutMsOverride: 1000,
    piCommandOverride: { command: process.execPath, argsPrefix: ["--import", "tsx/esm", "-e", code, "--"] },
    onLeadMessage,
    makeDetails: () => {
      throw new Error("no details expected");
    },
  };
}

function protocol(onLeadMessage?: RunAgentOptions["onLeadMessage"]) {
  const result = makeRunningResult();
  const state: AttemptState = {
    resolved: false,
    receivedFirstEvent: false,
    agentSettled: false,
    startupTimedOut: false,
    wasAborted: false,
    activeToolCallIds: new Set(),
  };
  let activity = 0;
  let updates = 0;
  const handle = createProtocolHandler({
    state,
    result,
    onLeadMessage,
    promptRequestId: "initial",
    emitUpdate: () => {
      updates++;
    },
    noteSemanticActivity: () => {
      activity++;
    },
    stopChild() {},
    doResolve() {},
    forceStopAndSettle() {},
  });
  return { handle, result, state, activity: () => activity, updates: () => updates };
}

function notification(message: unknown): string {
  return JSON.stringify({ type: LEAD_MESSAGE_EVENT_TYPE, message });
}

test("protocol intercepts stdout notifications without transcript, progress, or startup side effects", async () => {
  const messages: string[] = [];
  const p = protocol((message) => {
    messages.push(message);
  });
  p.handle(notification("first"));
  p.handle(notification("second"));
  p.handle(notification(" "));
  p.handle(notification(123));
  assert.deepEqual(messages, ["first", "second"]);
  assert.equal(p.activity(), 2);
  assert.equal(p.updates(), 0);
  assert.equal(p.state.receivedFirstEvent, false);
  assert.deepEqual(p.result.messages, []);
  assert.equal(p.result.stderr, "");
  assert.equal(p.result.usage.turns, 0);
  p.state.agentSettled = true;
  p.handle(notification("buffered before close"));
  assert.equal(p.activity(), 2, "do not rearm the watchdog after settlement");
  p.state.resolved = true;
  p.handle(notification("stale"));
  assert.deepEqual(messages, ["first", "second", "buffered before close"]);
});

test("notification callback throws and rejections do not break child stream handling", async () => {
  for (const callback of [
    () => {
      throw new Error("sync");
    },
    () => Promise.reject(new Error("async")),
  ]) {
    const p = protocol(callback);
    assert.doesNotThrow(() => p.handle(notification("hello")));
    p.handle(JSON.stringify({ type: "turn_start" }));
    await Promise.resolve();
    assert.match(p.result.stderr, /Lead message callback failed/);
    assert.equal(p.result.turnInProgress, true);
    assert.equal(p.result.stopReason, undefined);
  }
});

test(
  "stderr notifications survive split UTF-8, CRLF, and an unterminated final record",
  { timeout: 10000 },
  async () => {
    const message = "first 😀 終\nwith newline";
    const rawEvent = notification("ordinary stderr JSON, not a notification");
    const malformed = LEAD_MESSAGE_STDERR_PREFIX + "not JSON";
    const code = `
    process.stdin.once("data", async () => {
      process.stdout.write(JSON.stringify({type: "turn_start"}) + "\\n");
      process.stderr.write("diagnostic without LF");
      const wire = Buffer.from(${JSON.stringify(encodeLeadMessage(message).replace(/\n$/, "\r\n"))});
      const split = wire.indexOf(Buffer.from("😀")) + 1;
      process.stderr.write(wire.subarray(0, split));
      await new Promise(resolve => setTimeout(resolve, 25));
      process.stderr.write(wire.subarray(split));
      process.stderr.write(${JSON.stringify(malformed + "\n" + rawEvent + "\n")});
      process.stderr.end(${JSON.stringify(encodeLeadMessage("last message").trim())}, () => {
        process.stdout.write(JSON.stringify({type: "agent_settled"}) + "\\n");
      });
    });
  `;
    const messages: string[] = [];
    const result = makeRunningResult();
    const outcome = await runAttempt(
      options(code, (message) => {
        messages.push(message);
      }),
      result,
      [],
      "test",
      0,
      () => {},
    );
    assert.equal(outcome.exitCode, 0, result.stderr);
    assert.deepEqual(messages, [message, "last message"]);
    assert.equal(result.stderr, `diagnostic without LF\n${malformed}\n${rawEvent}\n`);
    assert.deepEqual(result.messages, []);
  },
);

test("real child tool sends without waiting for the lead callback to finish", { timeout: 90000 }, async () => {
  const toolUrl = new URL("../extension/lead-message-tool.ts", import.meta.url).href;
  const code = `
    process.stdin.once("data", async () => {
      const {createLeadMessageTool} = await import(${JSON.stringify(toolUrl)});
      const tool = createLeadMessageTool();
      await tool.execute("one", {message: "found the bug"}, undefined, undefined, {});
      await tool.execute("two", {message: "still working"}, undefined, undefined, {});
      process.stdout.write(JSON.stringify({type: "message_end", message: {role: "assistant", content: "done", stopReason: "stop"}}) + "\\n");
      process.stdout.write(JSON.stringify({type: "agent_settled"}) + "\\n");
    });
  `;
  const messages: string[] = [];
  const result = makeRunningResult();
  const outcome = await runAttempt(
    options(code, (message) => {
      messages.push(message);
      return new Promise<void>(() => {});
    }),
    result,
    [],
    "test",
    0,
    () => {},
  );
  assert.equal(outcome.exitCode, 0, result.stderr);
  assert.deepEqual(messages, ["found the bug", "still working"]);
  assert.equal(result.stderr, "");
  assert.deepEqual(
    result.messages.map((message) => message.content),
    ["done"],
  );
});

test("notifications are safely consumed when the caller omits the callback", { timeout: 10000 }, async () => {
  const code = `
    process.stdin.once("data", () => {
      process.stderr.write(${JSON.stringify(encodeLeadMessage("no listener"))});
      process.stdout.write(JSON.stringify({type: "agent_settled"}) + "\\n");
    });
  `;
  const result = makeRunningResult();
  const outcome = await runAttempt(options(code), result, [], "test", 0, () => {});
  assert.equal(outcome.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.messages, []);
});
