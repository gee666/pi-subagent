import assert from "node:assert/strict";
import { test } from "node:test";
import { createProtocolHandler, createSteeringHandle } from "../runner/protocol.js";
import type { AttemptState } from "../runner/attempt-state.js";
import { makeRunningResult, makeTextMessage } from "./helpers/results.js";

function fixture(onLeadMessage?: (message: string) => void | Promise<void>) {
  const state: AttemptState = {
    resolved: false,
    receivedFirstEvent: true,
    agentSettled: false,
    startupTimedOut: false,
    wasAborted: false,
    activeToolCallIds: new Set(),
  };
  const result = makeRunningResult({ messages: [makeTextMessage("My implementation is ready.")] });
  const notifications: string[] = [];
  let stopped = 0;
  const line = createProtocolHandler({
    state,
    result,
    promptRequestId: "initial",
    emitUpdate() {},
    noteSemanticActivity() {},
    stopChild() {},
    doResolve() {},
    forceStopAndSettle() {
      stopped++;
    },
    onLeadMessage:
      onLeadMessage ??
      ((message) => {
        notifications.push(message);
      }),
  });
  const event = (value: Record<string, unknown>) => line(JSON.stringify(value));
  const handle = createSteeringHandle({
    state,
    result,
    promptRequestId: "initial",
    noteSemanticActivity() {},
    sendRpc: () => true,
    settleDeferred: () => event({ type: "agent_settled" }),
  });
  return { state, result, notifications, event, handle, stopped: () => stopped };
}

test("a settled parent reports idle with its own answer, then finishes only after its descendants", () => {
  const f = fixture();
  f.event({ type: "subagent_background", running: 2 });
  f.event({ type: "agent_settled" });
  assert.equal(f.result.idle, true);
  assert.equal(f.handle.isIdle?.(), true);
  assert.equal(f.state.agentSettled, false);
  assert.equal(f.stopped(), 0);
  assert.deepEqual(f.notifications, ["Idle, waiting for children.\nMy implementation is ready."]);
  f.event({ type: "agent_settled" });
  assert.equal(f.notifications.length, 1, "duplicate settlement must not repeat the notification");
  f.event({ type: "subagent_background", running: 1 });
  f.event({ type: "turn_start" });
  assert.equal(f.result.idle, false);
  assert.equal(f.handle.isIdle?.(), false);
  f.event({ type: "agent_settled" });
  assert.equal(f.notifications.length, 2, "a later turn can wait again");
  assert.equal(f.stopped(), 0);
  f.event({ type: "subagent_background", running: 0 });
  assert.equal(f.stopped(), 0, "delivery starts a continuation before final settlement");
  f.event({ type: "turn_start" });
  f.event({ type: "agent_settled" });
  assert.equal(f.state.agentSettled, true);
  assert.equal(f.stopped(), 1);
});

test("an agent without running children finishes without an idle report", () => {
  const f = fixture();
  f.event({ type: "agent_settled" });
  assert.equal(f.stopped(), 1);
  assert.equal(f.notifications.length, 0);
});

test("idle reports do not wait for the lead to process the message", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(() => gate);
  f.event({ type: "subagent_background", running: 1 });
  f.event({ type: "agent_settled" });
  assert.equal(f.state.waitingForChildren, true);
  f.event({ type: "subagent_background", running: 0 });
  f.event({ type: "turn_start" });
  f.event({ type: "agent_settled" });
  assert.equal(f.stopped(), 1);
  release();
  await gate;
});

test("rejected lead notification does not terminate a waiting parent", async () => {
  const f = fixture(async () => {
    throw new Error("transport failed");
  });
  f.event({ type: "subagent_background", running: 1 });
  f.event({ type: "agent_settled" });
  await Promise.resolve();
  assert.equal(f.stopped(), 0);
  assert.match(f.result.stderr, /Idle notification failed/);
});
