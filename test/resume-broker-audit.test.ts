import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerSessionEvents } from "../extension/events.js";
import { createExtensionState } from "../extension/state.js";
import { restoreBrokerJobs } from "../extension/broker-jobs.js";
import { schedulerFor } from "../extension/scheduler.js";
import { BROKER_DIR_ENV, BROKER_SECRET_ENV } from "../broker/contracts.js";
import { persistBrokerResult, submitBrokerJob } from "../broker/files.js";
import { shutdownRootBroker } from "../broker/root.js";
import { WORKER_TOKEN_ENV } from "../runner/tree-admission.js";
import { createExtensionHarness, customEntry, messageEntry, resumeBranch } from "./helpers/extension.js";
import { fixture, until } from "./helpers/message-subagent.js";
import { settingsFixture } from "./helpers/settings.js";
import { makeResult } from "./helpers/results.js";

for (const pending of ["background", "completion"] as const) {
  test(`tree navigation cannot synthetically resume while ${pending} work has no active handle`, async () => {
    const f = settingsFixture();
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const pi = {
      getFlag: () => undefined,
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
      getActiveTools: () => ["subagents"],
      setActiveTools: () => {},
      setModel: async () => true,
    } as unknown as ExtensionAPI;
    const state = createExtensionState(pi);
    state.sessionActive = true;
    state.canDelegate = true;
    const host = createExtensionHarness();
    const baseCtx = host.makeCtx(resumeBranch(), { cwd: f.project, hasUI: false });
    const ctx = { ...baseCtx, sessionManager: { ...baseCtx.sessionManager, getSessionFile: () => undefined } };
    state.latestSessionCtx = ctx;
    if (pending === "background") {
      state.backgroundJobs.set("queued-before-handle", {
        names: ["queued worker"],
        controller: new AbortController(),
        promise: Promise.resolve(),
      });
    } else {
      state.pendingCompletionDeliveries.set("not-consumed-yet", state.lifecycleGeneration);
    }
    registerSessionEvents(state);
    try {
      assert.equal(state.activeSubagents.size, 0);
      await handlers.get("session_tree")!({ type: "session_tree", newLeafId: "result-call-1" }, ctx);
      assert.equal(state.pendingResumePlans.length, 0, "existing live work must not produce a second recovery launch");
      assert.equal(state.resumeState.plans.length, 0);
      state.backgroundJobs.clear();
      state.pendingCompletionDeliveries.clear();
      await handlers.get("session_tree")!({ type: "session_tree", newLeafId: "result-call-1" }, ctx);
      assert.equal(state.pendingResumePlans.length, 1, "the same unfinished branch recovers once live work is drained");
    } finally {
      for (const timer of state.scheduledTasks) clearTimeout(timer);
      state.backgroundJobs.clear();
      state.pendingCompletionDeliveries.clear();
      f.close();
    }
  });
}

test("completion on an abandoned branch cannot suppress durable broker replay on the current branch", async () => {
  const f = await fixture();
  const scheduler = schedulerFor(f.state),
    endpoint = scheduler.brokerEndpoint!,
    store = scheduler.treeStore!;
  const parent = store.enqueue("Parent");
  assert.equal(store.claim(parent), "running");
  store.bindPid(parent, process.pid);
  const keys = [BROKER_DIR_ENV, BROKER_SECRET_ENV, WORKER_TOKEN_ENV];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    [BROKER_DIR_ENV]: endpoint.directory,
    [BROKER_SECRET_ENV]: endpoint.secret,
    [WORKER_TOKEN_ENV]: parent,
  });
  try {
    const receipt = submitBrokerJob(endpoint, {
      ownerToken: parent,
      ownerId: f.state.currentOwnerId,
      toolCallId: "saved-launch",
      taskIndex: 0,
      name: f.name,
      agents: [],
      task: { agent: "worker", task: "finished child" },
      cwd: f.ctx.cwd,
      projectTrusted: true,
      parentDepth: 1,
      maxDepth: 3,
      parentAgentStack: [],
      preventCycles: false,
      budget: f.budget,
      sessionDir: f.sessionDir,
      sessionRoot: f.state.currentSubagentSessionRoot,
      namesFile: f.state.currentNamesFile,
      resumeSession: true,
    });
    persistBrokerResult(endpoint, receipt.id, makeResult({ name: f.name, finalOutput: "saved child result" }));
    const branch: SessionEntry[] = [customEntry("current-branch-head", {})];
    const abandonedCompletion = messageEntry(
      {
        role: "custom",
        customType: "subagent_completion",
        content: "answer on abandoned branch",
        display: true,
        details: { brokerJobId: receipt.id },
        timestamp: Date.now(),
      },
      "abandoned-completion",
    );
    const ctx = {
      ...f.ctx,
      mode: "rpc",
      ui: { setStatus: () => {} },
      sessionManager: {
        getEntries: () => [...branch, abandonedCompletion],
        getLeafId: () => branch.at(-1)!.id,
        getBranch: () => branch,
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;
    const sent: Array<Parameters<ExtensionAPI["sendMessage"]>[0]> = [];
    f.state.pi.sendMessage = (message) => {
      sent.push(message);
    };
    f.state.currentDepth = 1;
    f.state.latestSessionCtx = ctx;
    assert.equal(await restoreBrokerJobs(f.state, ctx), true, "current branch has not consumed this completion");
    await until(() => sent.length === 1);
    assert.equal(Reflect.get(sent[0].details!, "brokerJobId"), receipt.id);
    assert.match(JSON.stringify(sent[0].content), /saved child result/);
    assert.equal(store.snapshot().filter((entry) => entry.name === f.name).length, 1, "replay never relaunches work");
    branch.push(messageEntry(abandonedCompletion.message, "current-completion"));
    assert.equal(
      await restoreBrokerJobs(f.state, ctx),
      false,
      "only persisted context on the active branch dedupes replay",
    );
  } finally {
    await shutdownRootBroker(endpoint);
    f.state.currentDepth = 0;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await f.close();
  }
});
