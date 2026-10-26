import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
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

async function setup(idle = false) {
  const f = await fixture();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  f.state.pi.on = ((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }) as ExtensionAPI["on"];
  let shortcut: Parameters<ExtensionAPI["registerShortcut"]>[1] | undefined;
  f.state.pi.registerShortcut = (key, options) => {
    assert.equal(key, "alt+w");
    assert.equal(matchesKey("\u001bw", key), true);
    assert.equal(matchesKey("\u001b[119;3u", key), true);
    shortcut = options;
  };
  let aborts = 0;
  const notices: string[] = [];
  Object.assign(f.ctx, {
    mode: "tui",
    hasUI: true,
    model: { provider: "original", id: "provider-model" },
    sessionManager: { getEntries: () => [], getLeafId: () => "leaf" },
    isIdle: () => idle,
    abort: () => {
      aborts++;
      idle = true;
    },
    ui: {
      onTerminalInput() {
        assert.fail("subagent interrupts must not subscribe to raw terminal input");
      },
      notify(message: string) {
        notices.push(message);
      },
      setWidget() {},
    },
  });
  registerSubagentInterrupt(f.state);
  const event = (name: string, value: unknown) => handlers.get(name)!(value, f.ctx);
  const emit = (name: string, ctx = f.ctx) =>
    name === "session_start" ? f.state.onSessionReadyForInterrupt?.(ctx) : handlers.get(name)!({}, ctx);
  emit("session_start");
  return {
    ...f,
    emit,
    event,
    notices,
    interrupt() {
      f.ctx.abort();
      event("agent_settled", { type: "agent_settled", aborted: true });
    },
    settle(aborted = false) {
      event("agent_settled", { type: "agent_settled", aborted });
    },
    mainOnly() {
      assert.ok(shortcut);
      return shortcut.handler(f.ctx);
    },
    setIdle(value: boolean) {
      idle = value;
    },
    get aborts() {
      return aborts;
    },
  };
}

test("Pi abort stops real running workers and queued work", { timeout: 15000 }, async () => {
  const f = await setup();
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
    f.interrupt();
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
});

test("Alt+W preserves subagents only for its own aborted run; a later Pi interrupt stops them", async () => {
  const f = await setup();
  const runner = gatedRunner(f);
  try {
    const result = await f.launch({ tasks: [{ task: "work", max_subagents_allowed: 0 }] });
    assertSuccess(result);
    await until(() => runner.runs().length === 1);
    const epoch = f.state.interruptEpoch;
    await f.mainOnly();
    assert.equal(f.aborts, 1);
    f.settle(true);
    assert.equal(f.state.backgroundJobs.size, 1);
    assert.equal(f.state.activeSubagents.size, 1);
    assert.equal(f.state.interruptEpoch, epoch);
    assert.equal(readWorkerStops(f.state.currentNamesFile).size, 0);
    f.setIdle(false);
    f.interrupt();
    assert.equal(f.aborts, 2);
    await until(() => f.state.backgroundJobs.size === 0);
    assert.equal(f.state.activeSubagents.size, 0);
  } finally {
    f.emit("session_shutdown");
    await f.close();
  }
});

test("Pi abort kills broker-only detached descendants and cancels queued descendants", { timeout: 10000 }, async () => {
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
    f.interrupt();
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
  test(`Pi abort suppresses pending successful and failed completions ${alreadyQueued ? "already queued in Pi" : "before delivery"}`, async (t) => {
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
      f.interrupt();
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
    f.interrupt();
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
    f.interrupt();
    assert.deepEqual(f.event("input", { source: "extension", text: prompt }), { action: "handled" });
    sendAutomaticResumePrompt(f.state, prompt);
    f.interrupt();
    // An earlier input hook already ran before interruption; loop-entry cancellation remains.
    f.event("before_agent_start", { messageType: "user", prompt });
    const before = f.aborts;
    f.event("agent_start", {});
    assert.equal(f.aborts, before + 1);
    sendAutomaticResumePrompt(f.state, prompt);
    f.event("before_agent_start", { messageType: "user", prompt });
    f.interrupt();
    const interrupted = f.aborts;
    f.event("agent_start", {});
    assert.equal(f.aborts, interrupted + 1, "interruption during later preflight also cancels loop entry");
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

test("idle shortcuts and normal settlement cannot arm or trigger a later abort exception", async () => {
  const f = await setup(true);
  let kills = 0;
  f.state.activeSubagents.set(1, {
    agent: "",
    task: "work",
    handle: {
      steer() {},
      kill() {
        kills++;
      },
    },
  });
  try {
    await f.mainOnly();
    assert.equal(f.aborts, 0);
    f.settle();
    assert.equal(kills, 0);
    f.setIdle(false);
    f.interrupt();
    assert.equal(kills, 1);
    assert.equal(f.aborts, 1);
    assert.equal(cachedSchedulerFor(f.state), undefined);
  } finally {
    f.emit("session_shutdown");
    await f.close();
  }
});
