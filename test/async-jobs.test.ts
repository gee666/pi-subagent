import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, MessageStartEvent } from "@earendil-works/pi-coding-agent";
import { registerAsyncDeliveryEvents, startBackground, stopBackgroundJobs } from "../extension/async-jobs.js";
import { publishCompletion } from "../extension/completion.js";
import { createExtensionState } from "../extension/state.js";
import { runAttempt } from "../runner/attempt.js";
import { createProtocolHandler } from "../runner/protocol.js";
import type { AttemptState } from "../runner/attempt-state.js";
import { makeResult, makeRunningResult } from "./helpers/results.js";
import { buildSubagentDetails, SUBAGENT_COMPLETION_TYPE } from "../types.js";

type Completion = Parameters<ExtensionAPI["sendMessage"]>[0];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(t: TestContext, onSend?: (message: Completion) => void) {
  const sent: Completion[] = [];
  const counts: number[] = [];
  const handlers = new Map<string, (event: MessageStartEvent) => unknown>();
  const pi = {
    getFlag: () => undefined,
    on(name: string, handler: (event: MessageStartEvent) => unknown) {
      handlers.set(name, handler);
    },
    sendMessage(message: Completion, options: Parameters<ExtensionAPI["sendMessage"]>[1]) {
      assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
      sent.push(message);
      onSend?.(message);
    },
  } as unknown as ExtensionAPI;
  const state = createExtensionState(pi);
  state.currentDepth = 1;
  state.sessionActive = true;
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", ((chunk: string | Uint8Array) => {
    const text = String(chunk);
    if (text.startsWith('{"type":"subagent_background",')) {
      counts.push(JSON.parse(text).running);
      return true;
    }
    return write(chunk);
  }) as typeof process.stdout.write);
  registerAsyncDeliveryEvents(state);
  t.after(() => {
    for (const timer of state.scheduledTasks) clearTimeout(timer);
    state.pendingCompletionDeliveries.clear();
  });
  function consume(message: Completion) {
    handlers.get("message_start")?.({
      type: "message_start",
      message: { ...message, role: "custom", timestamp: Date.now() },
    });
  }
  return { state, sent, counts, handlers, consume };
}

function protocol() {
  let stops = 0;
  const state: AttemptState = {
    resolved: false,
    receivedFirstEvent: true,
    agentSettled: false,
    startupTimedOut: false,
    wasAborted: false,
    activeToolCallIds: new Set(),
  };
  const handle = createProtocolHandler({
    state,
    result: makeRunningResult(),
    promptRequestId: "initial",
    emitUpdate() {},
    noteSemanticActivity() {},
    stopChild() {},
    doResolve() {},
    forceStopAndSettle() {
      stops++;
    },
  });
  return { stops: () => stops, emit: (event: object) => handle(JSON.stringify(event)) };
}

test("completion keepalive spans scheduling, enqueueing, and consumption before settlement", async (t) => {
  const f = fixture(t);
  const p = protocol();
  const result = makeResult();
  startBackground(f.state, "job", ["Alice"], async () => {
    publishCompletion(f.state, result, f.state.lifecycleGeneration, { jobId: "launch", taskIndex: 0 });
    return { content: [], details: buildSubagentDetails("single", "spawn", null, [result]) };
  });
  await f.state.backgroundJobs.get("job")!.promise;
  assert.equal(f.state.backgroundJobs.size, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.state.pendingCompletionDeliveries.size, 1);
  assert.deepEqual(f.counts, [1, 2, 1]);
  p.emit({ type: "subagent_background", running: f.counts.at(-1) });
  p.emit({ type: "agent_settled" });
  assert.equal(p.stops(), 0, "must not reap before the delivery timer fires");
  await delay(10);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].customType, SUBAGENT_COMPLETION_TYPE);
  assert.equal(f.state.pendingCompletionDeliveries.size, 1, "enqueueing is not consumption");
  p.emit({ type: "agent_settled" });
  assert.equal(p.stops(), 0);
  // An unrelated run must not release a scheduled or queued completion.
  assert.equal(f.handlers.has("agent_start"), false);
  assert.equal(f.handlers.has("before_agent_start"), false);
  p.emit({ type: "turn_start" });
  f.consume(f.sent[0]);
  assert.equal(f.state.pendingCompletionDeliveries.size, 0);
  p.emit({ type: "subagent_background", running: f.counts.at(-1) });
  p.emit({ type: "agent_settled" });
  assert.equal(p.stops(), 1);
});

test("each queued completion drains only on its matching message_start, including within an existing run", async (t) => {
  const f = fixture(t);
  const key = { jobId: "launch", taskIndex: 2 };
  publishCompletion(f.state, makeResult(), 0, key);
  publishCompletion(f.state, makeResult(), 0, key);
  await delay(10);
  assert.equal(f.state.pendingCompletionDeliveries.size, 2);
  const first = JSON.parse(JSON.stringify(f.sent[0])) as Completion;
  const second = JSON.parse(JSON.stringify(f.sent[1])) as Completion;
  const details = first.details as { asyncJobId: string; asyncTaskIndex: number; asyncDeliveryId: string };
  assert.equal(details.asyncJobId, "launch");
  assert.equal(details.asyncTaskIndex, 2);
  assert.notEqual(details.asyncDeliveryId, (second.details as typeof details).asyncDeliveryId);
  f.consume({ ...first, customType: "other" });
  f.consume({ ...first, details: { asyncDeliveryId: "unknown" } });
  f.consume({ ...first, details: { asyncDeliveryId: 1 } });
  f.consume({ ...first, details: null });
  assert.equal(f.state.pendingCompletionDeliveries.size, 2);
  f.consume(second);
  f.consume(second);
  assert.equal(f.state.pendingCompletionDeliveries.size, 1, "duplicate events cannot drain another completion");
  f.consume(first);
  assert.equal(f.state.pendingCompletionDeliveries.size, 0);
  assert.deepEqual(f.counts, [1, 2, 1, 0]);
});

test("synchronous consumption during sendMessage does not leak a reservation", async (t) => {
  const f = fixture(t, (message) => f.consume(message));
  publishCompletion(f.state, makeResult(), 0);
  await delay(10);
  assert.equal(f.sent.length, 1);
  assert.equal(f.state.pendingCompletionDeliveries.size, 0);
  assert.deepEqual(f.counts, [1, 0]);
});

test("stale timers and old delivery events cannot send to or drain a new session", async (t) => {
  const f = fixture(t);
  publishCompletion(f.state, makeResult(), 0);
  await delay(10);
  const old = f.sent[0];
  publishCompletion(f.state, makeResult(), 0);
  f.state.sessionActive = false;
  f.state.lifecycleGeneration++;
  f.state.pendingCompletionDeliveries.clear(); // The session lifecycle owns cancellation.
  f.state.sessionActive = true;
  publishCompletion(f.state, makeResult(), 0);
  publishCompletion(f.state, makeResult(), 1);
  await delay(10);
  assert.equal(f.sent.length, 2);
  f.consume(old);
  assert.equal(f.state.pendingCompletionDeliveries.size, 1);
  f.state.sessionActive = false;
  f.consume(f.sent[1]);
  assert.equal(f.state.pendingCompletionDeliveries.size, 1);
  f.state.sessionActive = true;
  f.consume(f.sent[1]);
  assert.equal(f.state.pendingCompletionDeliveries.size, 0);
});

test("a synchronous send failure is reported and releases its undeliverable reservation", async (t) => {
  const f = fixture(t, () => {
    throw new Error("send failed");
  });
  const error = t.mock.method(console, "error", () => {});
  publishCompletion(f.state, makeResult(), 0);
  await delay(10);
  assert.equal(f.state.pendingCompletionDeliveries.size, 0);
  assert.deepEqual(f.counts, [1, 0]);
  assert.match(String(error.mock.calls[0].arguments[1]), /send failed/);
});

test("stopBackgroundJobs awaits child settlement and async cleanup without deleting replacement jobs", async (t) => {
  const f = fixture(t);
  const done = deferred();
  const cleanup = deferred();
  let cleaning = false;
  startBackground(
    f.state,
    "old",
    [],
    async () => {
      await done.promise;
      return { content: [], details: buildSubagentDetails("single", "spawn", null, []) };
    },
    async () => {
      cleaning = true;
      await cleanup.promise;
    },
  );
  const old = f.state.backgroundJobs.get("old")!;
  let drained = false;
  const stopping = stopBackgroundJobs(f.state).then(() => {
    drained = true;
  });
  assert.equal(old.controller.signal.aborted, true);
  await delay(1);
  assert.equal(drained, false);
  const replacementDone = deferred();
  startBackground(f.state, "old", [], async () => {
    await replacementDone.promise;
    return { content: [], details: buildSubagentDetails("single", "spawn", null, []) };
  });
  const replacement = f.state.backgroundJobs.get("old")!;
  done.resolve();
  await delay(1);
  assert.equal(cleaning, true);
  assert.equal(drained, false, "cleanup remains part of the drained job");
  cleanup.resolve();
  await stopping;
  assert.equal(f.state.backgroundJobs.get("old"), replacement);
  assert.equal(replacement.controller.signal.aborted, false);
  replacementDone.resolve();
  await replacement.promise;
});

test("stopBackgroundJobs handles rejected promises and preserves new jobs outside its snapshot", async (t) => {
  const f = fixture(t);
  const done = deferred();
  const old = {
    names: [],
    controller: new AbortController(),
    promise: done.promise.then(() => {
      throw Error("failed");
    }),
  };
  f.state.backgroundJobs.set("old", old);
  const stopping = stopBackgroundJobs(f.state);
  const next = { names: [], controller: new AbortController(), promise: Promise.resolve() };
  f.state.backgroundJobs.set("next", next);
  done.resolve();
  await stopping;
  assert.equal(f.state.backgroundJobs.has("old"), false);
  assert.equal(f.state.backgroundJobs.get("next"), next);
  assert.equal(next.controller.signal.aborted, false);
});

test(
  "a nested RPC worker survives the idle gap until its queued completion is consumed",
  { timeout: 10000 },
  async () => {
    const jobsUrl = new URL("../extension/async-jobs.ts", import.meta.url).href;
    const completionUrl = new URL("../extension/completion.ts", import.meta.url).href;
    const stateUrl = new URL("../extension/state.ts", import.meta.url).href;
    const resultUrl = new URL("./helpers/results.ts", import.meta.url).href;
    const code = `
    process.stdin.once("data", async () => {
      const {startBackground, registerAsyncDeliveryEvents} = await import(${JSON.stringify(jobsUrl)});
      const {publishCompletion} = await import(${JSON.stringify(completionUrl)});
      const {createExtensionState} = await import(${JSON.stringify(stateUrl)});
      const {makeResult} = await import(${JSON.stringify(resultUrl)});
      const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
      let consume;
      const state = createExtensionState({
        getFlag() {},
        on(name, handler) { if (name === "message_start") consume = handler; },
        sendMessage(message) {
          setTimeout(() => {
            emit({type: "turn_start"});
            const custom = {...message, role: "custom", timestamp: Date.now()};
            consume({type: "message_start", message: custom});
            emit({type: "message_end", message: custom});
            emit({type: "message_end", message: {role: "assistant", content: [{type: "text", text: "processed completion"}], stopReason: "stop"}});
            emit({type: "agent_settled"});
          }, 50);
        },
      });
      state.sessionActive = true;
      state.currentDepth = 1;
      registerAsyncDeliveryEvents(state);
      emit({type: "turn_start"});
      startBackground(state, "child", [], async () => {
        publishCompletion(state, makeResult(), state.lifecycleGeneration);
        return {content: []};
      });
      await state.backgroundJobs.get("child").promise;
      emit({type: "agent_settled"});
    });
  `;
    const result = makeRunningResult();
    const outcome = await runAttempt(
      {
        cwd: process.cwd(),
        agents: [],
        agentName: "lead",
        task: "nested completion",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: false,
        settings: {},
        startupTimeoutMsOverride: 5000,
        idleTimeoutMsOverride: 1000,
        terminationTimeoutMsOverride: 500,
        piCommandOverride: { command: process.execPath, argsPrefix: ["--import", "tsx/esm", "-e", code, "--"] },
        makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
      },
      result,
      [],
      "initial",
      0,
      () => {},
    );
    assert.equal(outcome.exitCode, 0, result.stderr);
    assert.equal(result.messages.filter((message) => message.role === "custom").length, 1);
    assert.deepEqual(result.messages.at(-1)?.content, [{ type: "text", text: "processed completion" }]);
  },
);
