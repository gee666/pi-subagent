import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { registerSubagentInterrupt } from "../extension/interrupt.js";
import { cachedSchedulerFor, schedulerFor } from "../extension/scheduler.js";
import { killProcessTreeImmediately } from "../runner/launch.js";
import { readWorkerStops } from "../storage/worker-stops.js";
import { readBudget } from "../budget.js";
import { publishCompletion } from "../extension/completion.js";
import { sendAutomaticResumePrompt } from "../extension/runtime.js";
import { makeResult } from "./helpers/results.js";
import { emptyUsage } from "../types.js";
import { isSubagentDetails } from "../types.js";
import { fixture, gatedRunner, until, assertSuccess } from "./helpers/message-subagent.js";

async function setup(idle = true) {
  const f = await fixture();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  f.state.pi.on = ((name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
    handlers.set(name, handler);
  }) as ExtensionAPI["on"];
  let input: TerminalInputHandler | undefined;
  let aborts = 0;
  let unsubscriptions = 0;
  const notices: string[] = [];
  Object.assign(f.ctx, {
    mode: "tui",
    hasUI: true,
    model: { provider: "original", id: "provider-model" },
    sessionManager: { getEntries: () => [], getLeafId: () => "leaf" },
    isIdle: () => idle,
    abort: () => {
      aborts++;
    },
    ui: {
      onTerminalInput(handler: TerminalInputHandler) {
        input = handler;
        return () => {
          input = undefined;
          unsubscriptions++;
        };
      },
      notify(message: string) {
        notices.push(message);
      },
      setWidget() {},
    },
  });
  registerSubagentInterrupt(f.state);
  const emit = (event: string, ctx = f.ctx) =>
    event === "session_start" ? f.state.onSessionReadyForInterrupt?.(ctx) : handlers.get(event)!({}, ctx);
  emit("session_start");
  return {
    ...f,
    emit,
    notices,
    key: (data: string) => input?.(data),
    event: (name: string, event: unknown) => handlers.get(name)!(event, f.ctx),
    get input() {
      return input;
    },
    get aborts() {
      return aborts;
    },
    get unsubscriptions() {
      return unsubscriptions;
    },
  };
}

for (const idle of [true, false]) {
  test(
    `Escape stops real running workers and queued work while main is ${idle ? "idle" : "busy"}`,
    { timeout: 15000 },
    async () => {
      const f = await setup(idle);
      const runner = gatedRunner(f, true);
      f.state.settings = { ...f.state.settings, PI_SUBAGENT_MAX_CONCURRENCY: "1" };
      try {
        const result = await f.launch({
          tasks: [
            { task: "first", max_subagents_allowed: 0 },
            { task: "second", max_subagents_allowed: 0 },
          ],
        });
        assertSuccess(result);
        assert.ok(isSubagentDetails(result.details));
        const names = result.details.results.map((worker) => worker.name!);
        await until(() => runner.runs().length === 1);
        const before = readBudget(f.state.currentBudget!);
        f.key("x");
        f.key("\u001b[A");
        assert.equal(f.aborts, 0);
        f.key("\u001b");
        assert.equal(f.aborts, 1);
        for (const name of names) assert.ok(readWorkerStops(f.state.currentNamesFile).has(name));
        await until(() => f.state.backgroundJobs.size === 0);
        assert.equal(runner.runs().length, 1, "queued worker must never start");
        assert.equal(f.state.activeSubagents.size, 0);
        assert.deepEqual(readBudget(f.state.currentBudget!), before);
        assert.deepEqual(f.notices, []);
        assert.deepEqual(schedulerFor(f.state).snapshot(), []);
      } finally {
        f.emit("session_shutdown");
        await f.close();
      }
    },
  );
}

test("Escape kills broker-only detached descendants and cancels queued descendants", { timeout: 10000 }, async () => {
  const f = await setup();
  const processes = [0, 1].map(() =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    }),
  );
  const closed = processes.map((process) => once(process, "close"));
  try {
    const store = schedulerFor(f.state).treeStore!;
    const parent = store.enqueue("parent");
    assert.equal(store.claim(parent), "running");
    store.bindPid(parent, processes[0].pid!);
    const child = store.enqueue("detached-child", parent);
    assert.equal(store.claim(child), "running");
    store.bindPid(child, processes[1].pid!);
    const queued = store.enqueue("queued-child", parent);
    assert.equal(f.state.activeSubagents.size, 0);
    assert.equal(f.state.backgroundJobs.size, 0);
    f.key("\u001b");
    await Promise.all(closed);
    assert.equal(f.aborts, 1);
    assert.equal(store.get(queued)?.status, "canceled");
    assert.equal(store.get(child)?.status, "released");
    assert.equal(store.claim(store.enqueue("late-child", parent)), "canceled");
    for (const name of ["parent", "detached-child", "queued-child"])
      assert.ok(readWorkerStops(f.state.currentNamesFile).has(name));
    assert.deepEqual(f.notices, []);
  } finally {
    for (const process of processes) killProcessTreeImmediately(process);
    await Promise.all(closed);
    f.emit("session_shutdown");
    await f.close();
  }
});

for (const alreadyQueued of [false, true]) {
  test(`Escape suppresses pending successful and failed completions ${alreadyQueued ? "already queued in Pi" : "before delivery"}`, async (t) => {
    const f = await setup();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const deliveries: Array<{ trigger?: boolean; display?: boolean; details: unknown }> = [];
    f.state.pi.sendMessage = (message, options) => {
      deliveries.push({ trigger: options?.triggerTurn, display: message.display, details: message.details });
    };
    const abort = f.ctx.abort;
    f.ctx.abort = () => {
      deliveries.length = 0;
      abort();
    };
    try {
      for (const exitCode of [0, 130])
        publishCompletion(
          f.state,
          makeResult({
            name: `worker-${exitCode}`,
            exitCode,
            usage: { ...emptyUsage(), cost: 2 },
          }),
          f.state.lifecycleGeneration,
        );
      if (alreadyQueued) {
        t.mock.timers.tick(0);
        assert.equal(deliveries.length, 2);
        assert.ok(deliveries.every((delivery) => delivery.trigger));
      }
      assert.equal(f.state.backgroundJobs.size, 0);
      assert.equal(f.state.pendingCompletionDeliveries.size, 2);
      f.key("\u001b");
      assert.equal(f.aborts, 1);
      t.mock.timers.tick(0);
      assert.equal(deliveries.length, 2, "accounting is replayed once, without a continuation");
      for (const delivery of deliveries) {
        assert.equal(delivery.trigger, false);
        assert.equal(delivery.display, false);
        assert.ok(isSubagentDetails(delivery.details));
        assert.equal(delivery.details.usageSummary?.costUsd, 2);
      }
      assert.equal(f.state.pendingCompletionDeliveries.size, 0);
      assert.equal(f.state.pendingCompletionInterrupts.size, 0);
      assert.equal(cachedSchedulerFor(f.state), undefined);
      publishCompletion(f.state, makeResult({ name: "explicit-new-work" }), f.state.lifecycleGeneration);
      t.mock.timers.tick(0);
      assert.equal(deliveries.at(-1)?.trigger, true, "later explicit work can wake the main agent");
    } finally {
      f.emit("session_shutdown");
      await f.close();
    }
  });
}

test("late settlement from interrupted work cannot wake the main agent", async (t) => {
  const f = await setup();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const epoch = f.state.interruptEpoch;
  const options: unknown[] = [];
  f.state.pi.sendMessage = (_message, delivery) => {
    options.push(delivery);
  };
  try {
    f.key("\u001b");
    publishCompletion(f.state, makeResult(), f.state.lifecycleGeneration, undefined, undefined, epoch);
    t.mock.timers.tick(0);
    assert.deepEqual(options, [{ triggerTurn: false }]);
    assert.equal(f.state.pendingCompletionDeliveries.size, 0);
  } finally {
    f.emit("session_shutdown");
    await f.close();
  }
});

test("extension input without a pending automatic resume cannot read an interrupt epoch", async () => {
  const f = await setup();
  try {
    assert.equal(f.state.pendingAutomaticResume, undefined);
    for (const input of [
      { source: "extension" },
      { source: "extension", text: "" },
      { source: "extension", text: "hi" },
    ]) {
      assert.equal(f.event("input", input), undefined);
    }
    f.event("before_agent_start", { messageType: "user" });
    f.event("agent_start", {});
    assert.equal(f.aborts, 0);
  } finally {
    f.emit("session_shutdown");
    await f.close();
  }
});

test("automatic prompts retain their submission epoch through delayed preflight", async () => {
  const f = await setup();
  f.state.pi.sendUserMessage = () => {};
  try {
    const prompt = "Resuming 2 subagents...";
    sendAutomaticResumePrompt(f.state, prompt);
    f.key("\u001b");
    assert.deepEqual(f.event("input", { source: "extension", text: prompt }), { action: "handled" });
    sendAutomaticResumePrompt(f.state, prompt);
    f.key("\u001b");
    // An earlier input hook already ran before Escape, so only loop-entry cancellation remains.
    f.event("before_agent_start", { messageType: "user", prompt });
    const before = f.aborts;
    f.event("agent_start", {});
    assert.equal(f.aborts, before + 1);
    sendAutomaticResumePrompt(f.state, prompt);
    f.event("before_agent_start", { messageType: "user", prompt });
    f.key("\u001b");
    const interrupted = f.aborts;
    f.event("agent_start", {});
    assert.equal(f.aborts, interrupted + 1, "Escape during later preflight also cancels loop entry");
  } finally {
    f.emit("session_shutdown");
    await f.close();
  }
});

test("custom-message starts do not consume a pending automatic user prompt", async () => {
  const f = await setup();
  f.state.pi.sendUserMessage = () => {};
  try {
    const prompt = "Resuming 2 subagents...";
    sendAutomaticResumePrompt(f.state, prompt);
    const pending = f.state.pendingAutomaticResume;
    f.event("before_agent_start", {
      messageType: "custom",
      message: { customType: "subagent_completion", content: "done", display: true },
    });
    assert.equal(f.state.pendingAutomaticResume, pending);
    const before = f.aborts;
    f.event("agent_start", {});
    assert.equal(f.aborts, before);
    f.event("before_agent_start", { messageType: "user", prompt });
    assert.equal(f.state.pendingAutomaticResume, undefined);
  } finally {
    f.emit("session_shutdown");
    await f.close();
  }
});

test("Escape leaves unused sessions alone and subscriptions follow the session lifecycle", async () => {
  const f = await setup();
  try {
    f.key("\u001b");
    assert.equal(f.aborts, 0, "native Escape remains responsible for main-only interruption");
    assert.equal(cachedSchedulerFor(f.state), undefined);
    const stale = f.input!;
    f.state.lifecycleGeneration++;
    f.emit("session_start");
    assert.equal(f.unsubscriptions, 1);
    stale("\u001b");
    assert.equal(f.aborts, 0);
    f.emit("session_shutdown");
    assert.equal(f.input, undefined);
    assert.equal(f.unsubscriptions, 2);
    for (const mode of ["rpc", "json", "print"] as const) {
      f.emit("session_start", { ...f.ctx, mode });
      assert.equal(f.input, undefined);
    }
  } finally {
    await f.close();
  }
});
