/**
 * Tree navigation cancels only subagent recovery. Live workers keep reporting,
 * and nested workers never ask a recovery question their parent cannot answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyLead } from "../extension/async-jobs.js";
import { publishCompletion } from "../extension/completion.js";
import { registerSessionEvents } from "../extension/events.js";
import { registerSubagentInterrupt } from "../extension/interrupt.js";
import { maybeOfferSubagentResume } from "../extension/resume-offer.js";
import { sendAutomaticResumePrompt } from "../extension/runtime.js";
import { createExtensionState } from "../extension/state.js";
import { RESUME_PROVIDER } from "../shared.js";
import { createExtensionHarness, hostDouble, resumeBranch } from "./helpers/extension.js";
import { makeResult } from "./helpers/results.js";
import { settingsFixture } from "./helpers/settings.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Delivery = {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
};

const PROMPT = "Resuming 2 subagents...";

function setup() {
  // Clears inherited worker env (depth, budget, broker) before state reads it.
  const f = settingsFixture();
  const handlers = new Map<string, Handler[]>();
  const sent: Delivery[] = [];
  const pi = hostDouble<ExtensionAPI>({
    events: createEventBus(),
    getFlag: () => undefined,
    registerShortcut() {},
    on: ((name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }) as ExtensionAPI["on"],
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    sendUserMessage() {},
    async setModel() {
      return true;
    },
  });
  const state = createExtensionState(pi);
  state.sessionActive = true;
  state.lifecycleGeneration = 1;
  registerSessionEvents(state);
  registerSubagentInterrupt(state);
  let aborts = 0;
  const ctx = createExtensionHarness().makeCtx([], {
    abort: () => {
      aborts++;
    },
  });
  state.latestSessionCtx = ctx;
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    const results: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, ctx));
    return results;
  };
  return {
    state,
    sent,
    emit,
    navigate: () => emit("session_tree", { newLeafId: "elsewhere", oldLeafId: "leaf" }),
    get aborts() {
      return aborts;
    },
    close() {
      for (const timer of state.scheduledTasks) clearTimeout(timer);
      state.pendingCompletionDeliveries.clear();
      f.close();
    },
  };
}

test("workers launched before a tree switch still deliver completions and messages", async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // A launch captures the interrupt epoch; browsing history afterwards is not an interrupt.
    const launchEpoch = s.state.interruptEpoch;
    await s.navigate();
    notifyLead(s.state, "Message from subagent Ada:\nhalfway", s.state.lifecycleGeneration, launchEpoch);
    publishCompletion(
      s.state,
      makeResult({ name: "Ada", finalOutput: "all done" }),
      s.state.lifecycleGeneration,
      undefined,
      undefined,
      launchEpoch,
    );
    t.mock.timers.tick(0);

    assert.equal(s.sent.length, 2);
    for (const { options } of s.sent) assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
    assert.match(String(s.sent[0].message.content), /halfway/);
    const completion = s.sent[1].message;
    assert.equal(completion.display, true);
    assert.match(String(completion.content), /Subagent Ada finished:\nall done/);
    assert.doesNotMatch(String(completion.content), /stopped as requested/);
  } finally {
    s.close();
  }
});

test("a queued automatic resume prompt is dropped at input after a tree switch", async () => {
  const s = setup();
  try {
    sendAutomaticResumePrompt(s.state, PROMPT);
    await s.navigate();
    const results = await s.emit("input", { text: PROMPT, source: "extension" });
    assert.ok(results.some((result) => JSON.stringify(result) === JSON.stringify({ action: "handled" })));
    assert.equal(s.state.pendingAutomaticResume, undefined);
  } finally {
    s.close();
  }
});

test("a tree switch during automatic prompt preflight aborts at loop entry", async () => {
  const s = setup();
  try {
    sendAutomaticResumePrompt(s.state, PROMPT);
    await s.emit("before_agent_start", { messageType: "user", prompt: PROMPT });
    await s.navigate();
    await s.emit("agent_start");
    assert.equal(s.aborts, 1);
  } finally {
    s.close();
  }
});

test("without a tree switch the automatic prompt proceeds", async () => {
  const s = setup();
  try {
    sendAutomaticResumePrompt(s.state, PROMPT);
    const results = await s.emit("input", { text: PROMPT, source: "extension" });
    assert.ok(results.every((result) => JSON.stringify(result) !== JSON.stringify({ action: "handled" })));
    await s.emit("before_agent_start", { messageType: "user", prompt: PROMPT });
    await s.emit("agent_start");
    assert.equal(s.aborts, 0);
  } finally {
    s.close();
  }
});

for (const depth of [1, 0]) {
  test(`${depth > 0 ? "a nested worker never asks" : "the root asks"} before recovering unfinished subagents`, async () => {
    const f = settingsFixture();
    try {
      const host = createExtensionHarness({ confirmAnswer: false });
      const state = createExtensionState(host.pi);
      state.sessionActive = true;
      state.canDelegate = true;
      state.currentDepth = depth;
      // An RPC worker has a UI context, but nobody on the other end answers dialogs.
      const ctx = host.makeCtx(resumeBranch(), { mode: "rpc" });
      await maybeOfferSubagentResume(state, ctx);

      assert.equal(host.calls.confirms, depth > 0 ? 0 : 1);
      assert.equal(
        host.calls.setModel.some((value) => value.provider === RESUME_PROVIDER),
        false,
      );
      assert.deepEqual(state.pendingResumePlans, []);
      assert.deepEqual(state.resumeState.plans, []);
    } finally {
      f.close();
    }
  });
}
