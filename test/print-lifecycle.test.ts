import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { registerAsyncDeliveryEvents, startBackground, stopBackgroundJobs } from "../extension/async-jobs.js";
import { publishCompletion } from "../extension/completion.js";
import { createExtensionState } from "../extension/state.js";
import { buildSubagentDetails } from "../types.js";
import { hostDouble } from "./helpers/host-double.js";
import { makeResult } from "./helpers/results.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(mode: ExtensionContext["mode"]) {
  type Name = ExtensionEvent["type"];
  type Event<K extends Name> = Extract<ExtensionEvent, { type: K }>;
  const handlers = new Map<Name, (event: ExtensionEvent, ctx: ExtensionContext) => unknown>();
  function on<K extends Name>(name: K, handler: (event: Event<K>, ctx: ExtensionContext) => unknown) {
    handlers.set(name, (event, ctx) => {
      assert.equal(event.type, name);
      // The registration key and checked discriminant establish this association, as in the extension harness.
      return handler(event as Event<K>, ctx);
    });
    return () => handlers.delete(name);
  }
  const messages: Parameters<ExtensionAPI["sendMessage"]>[0][] = [];
  const state = createExtensionState(
    hostDouble<ExtensionAPI>({
      getFlag: () => undefined,
      on: on as ExtensionAPI["on"],
      sendMessage(message, options) {
        assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
        messages.push(message);
      },
    }),
  );
  state.currentDepth = 0;
  state.sessionActive = true;
  const controller = new AbortController();
  const ctx = hostDouble<ExtensionContext>({
    mode,
    signal: controller.signal,
    // Pi's hasPendingMessages tracks user steering/follow-ups, not queued custom messages.
    hasPendingMessages: () => false,
  });
  registerAsyncDeliveryEvents(state);
  const settle = () =>
    handlers.get("agent_before_settle")?.(
      {
        type: "agent_before_settle",
        entries: [],
        continue: false,
        outcome: "completed",
        context: {
          contextEntries: [],
          contextMessages: [],
          llmMessages: [],
          pendingMessages: messages.map((message) => ({ ...message, role: "custom", timestamp: Date.now() })),
          canContinue: true,
        },
      },
      ctx,
    );
  const consume = () => {
    const message = messages.shift();
    assert.ok(message);
    handlers.get("message_start")?.(
      { type: "message_start", message: { ...message, role: "custom", timestamp: Date.now() } },
      ctx,
    );
  };
  return { state, messages, settle, consume, controller };
}

for (const mode of ["print", "json"] as const) {
  test(`${mode} settlement waits for each completion, including queued work and the delivery timer`, async () => {
    const f = fixture(mode);
    const first = deferred();
    const second = deferred();
    const result = makeResult({ finalOutput: "SUBAGENT-SAYS-42" });
    startBackground(f.state, "batch", ["Alice", "Bob"], async () => {
      await first.promise; // Also models a queued job that has not started yet.
      publishCompletion(f.state, result, 0);
      await second.promise;
      publishCompletion(f.state, result, 0);
      return { content: [], details: buildSubagentDetails("single", "spawn", null, [result]) };
    });
    let settled = false;
    const waiting = Promise.resolve(f.settle()).then(() => {
      settled = true;
    });
    await delay(5);
    assert.equal(settled, false, "print must not exit when the lead ends its turn");
    first.resolve();
    await waiting;
    assert.equal(f.messages.length, 1);
    assert.match(String(f.messages[0].content), /SUBAGENT-SAYS-42/);
    assert.equal(f.state.backgroundJobs.size, 1, "the first completion must wake the lead before the batch ends");
    f.consume();

    second.resolve();
    await f.state.backgroundJobs.get("batch")!.promise;
    assert.equal(f.state.backgroundJobs.size, 0);
    assert.equal(f.messages.length, 0, "delivery is still scheduled after job settlement");
    assert.equal(f.state.pendingCompletionDeliveries.size, 1);
    await f.settle();
    assert.equal(f.messages.length, 1, "the final completion must be queued before print can settle");
    f.consume();
    await f.settle();
    assert.equal(f.state.pendingCompletionDeliveries.size, 0);
    assert.equal(f.state.onBackgroundChanged, undefined);
  });
}

for (const mode of ["tui", "rpc"] as const) {
  test(`${mode} settlement remains nonblocking while subagents run`, async () => {
    const f = fixture(mode);
    f.state.backgroundJobs.set("queued", {
      names: [],
      controller: new AbortController(),
      promise: new Promise(() => {}),
    });
    await f.settle();
    assert.equal(f.state.onBackgroundChanged, undefined);
  });
}

test("aborting print releases the settlement wait without waiting for subagents", async () => {
  const f = fixture("print");
  f.state.backgroundJobs.set("queued", {
    names: [],
    controller: new AbortController(),
    promise: new Promise(() => {}),
  });
  const waiting = f.settle();
  assert.equal(typeof f.state.onBackgroundChanged, "function");
  f.controller.abort();
  await waiting;
  assert.equal(f.state.onBackgroundChanged, undefined);
});

test("stopping queued jobs releases print settlement even without a completion", async () => {
  const f = fixture("print");
  const done = deferred();
  const controller = new AbortController();
  controller.signal.addEventListener("abort", done.resolve, { once: true });
  f.state.backgroundJobs.set("queued", { names: [], controller, promise: done.promise });
  const waiting = f.settle();
  await stopBackgroundJobs(f.state);
  await waiting;
  assert.equal(f.state.backgroundJobs.size, 0);
});
