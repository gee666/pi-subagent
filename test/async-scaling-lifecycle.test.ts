import assert from "node:assert/strict";
import test from "node:test";
import { retainCompletionDelivery, releaseCompletionDelivery, startBackground } from "../extension/async-jobs.js";
import { emitNestedProgressToParent, trackProgress } from "../extension/progress.js";
import type { ExtensionState } from "../extension/state.js";
import type { SessionContext } from "../extension/contracts.js";
import { createProtocolHandler } from "../runner/protocol.js";
import type { AttemptState } from "../runner/attempt-state.js";
import { runAttempt } from "../runner/attempt.js";
import { executeParallelSubprocess } from "../runner/parallel.js";
import { buildLiveSubagentDetails, buildSubagentDetails, emptyUsage, type SingleResult } from "../types.js";
import { makeResult, makeRunningResult } from "./helpers/results.js";

function state(): ExtensionState {
  return {
    currentDepth: 0,
    lifecycleGeneration: 1,
    sessionActive: true,
    scheduledTasks: new Set(),
    backgroundJobs: new Map(),
    pendingCompletionDeliveries: new Map(),
    activeSubagents: new Map(),
    activeSubagentUsageSummaries: new Map(),
    latestBroadcastTargets: { all: [], youngest: [] },
    pi: { sendUserMessage() {} },
  } as unknown as ExtensionState;
}
const details = (results: SingleResult[]) => buildLiveSubagentDetails("parallel", "spawn", null, results);

test("delivery reservations and consumption do not rescan the pending queue", (t) => {
  const owner = state();
  owner.currentDepth = 1;
  let visits = 0,
    last = "";
  const pending = owner.pendingCompletionDeliveries;
  const values = pending.values.bind(pending);
  t.mock.method(pending, "values", () => {
    visits++;
    return values();
  });
  const write = t.mock.method(process.stdout, "write", (chunk: unknown) => {
    last = String(chunk);
    return true;
  });
  try {
    const tokens = Array.from({ length: 1000 }, () => retainCompletionDelivery(owner, 1));
    assert.equal(JSON.parse(last).running, 1000);
    for (const token of tokens) releaseCompletionDelivery(owner, token, 1);
    assert.equal(JSON.parse(last).running, 0);
    assert.equal(visits, 1, "normal mutations maintain a cached count");
    retainCompletionDelivery(owner, 1);
    owner.pendingCompletionDeliveries.clear();
    owner.lifecycleGeneration++;
    retainCompletionDelivery(owner, 2);
    assert.equal(JSON.parse(last).running, 1, "external clear and session replacement invalidate counts");
  } finally {
    write.mock.restore();
  }
});

test("nested progress does not queue or serialize snapshots behind stdout backpressure", (t) => {
  const owner = state();
  owner.currentDepth = 1;
  let projected = 0,
    written = 0;
  const snapshot = details([]);
  Object.defineProperty(snapshot, "results", {
    get() {
      projected++;
      return [];
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "writableNeedDrain");
  const write = t.mock.method(process.stdout, "write", () => {
    written++;
    return true;
  });
  try {
    Object.defineProperty(process.stdout, "writableNeedDrain", { configurable: true, value: true });
    for (let i = 0; i < 1000; i++) emitNestedProgressToParent(owner, "call", snapshot);
    assert.equal(written, 0);
    assert.equal(projected, 0);
    Object.defineProperty(process.stdout, "writableNeedDrain", { configurable: true, value: false });
    emitNestedProgressToParent(owner, "call", snapshot);
    assert.equal(written, 1, "a later heartbeat resumes normal progress delivery");
  } finally {
    if (descriptor) Object.defineProperty(process.stdout, "writableNeedDrain", descriptor);
    else Reflect.deleteProperty(process.stdout, "writableNeedDrain");
    write.mock.restore();
  }
});

test("old same-key background settlement cannot erase replacement accounting", async () => {
  const owner = state();
  let finish!: () => void;
  startBackground(
    owner,
    "same",
    ["old"],
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ content: [], details: details([]) });
      }),
  );
  const old = owner.backgroundJobs.get("same")!;
  await Promise.resolve();
  let finishNew!: () => void;
  startBackground(
    owner,
    "same",
    ["new"],
    () =>
      new Promise((resolve) => {
        finishNew = () => resolve({ content: [], details: details([]) });
      }),
  );
  await Promise.resolve();
  const current = owner.backgroundJobs.get("same")!;
  const summary = {
    subagentCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 3,
    turns: 0,
  };
  owner.activeSubagentUsageSummaries.set("same", summary);
  finish();
  await old.promise;
  assert.equal(owner.backgroundJobs.get("same"), current);
  assert.equal(owner.activeSubagentUsageSummaries.get("same"), summary);
  finishNew();
  await current.promise;
  assert.equal(owner.backgroundJobs.size, 0);
  assert.equal(owner.activeSubagentUsageSummaries.size, 0);
});

test("a thousand independent jobs share one trailing usage widget refresh", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const owner = state();
  let refreshes = 0;
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: { getEntries: () => [], getLeafId: () => "leaf" },
    ui: {
      setWidget() {
        refreshes++;
      },
    },
  } as unknown as SessionContext;
  const partial = { content: [], details: details([makeRunningResult()]) };
  for (let i = 0; i < 1000; i++) trackProgress(owner, `job-${i}`, i, ctx)(partial);
  assert.equal(
    owner.activeSubagentUsageSummaries.size,
    1000,
    "accounting is immediate even while display is throttled",
  );
  assert.equal(refreshes, 1);
  assert.equal(owner.scheduledTasks.size, 1);
  t.mock.timers.tick(100);
  assert.equal(refreshes, 2);
  assert.equal(owner.scheduledTasks.size, 0);
  trackProgress(owner, "next", 1001, ctx)(partial);
  for (const timer of owner.scheduledTasks) clearTimeout(timer);
  owner.scheduledTasks.clear();
  owner.lifecycleGeneration++;
  t.mock.timers.tick(1000);
  assert.equal(refreshes, 2);
  trackProgress(owner, "new-session", 1, ctx)(partial);
  assert.equal(refreshes, 3, "a cleared old timer must not block the new generation");
});

test("late progress cannot repopulate a replaced session's accounting", () => {
  const owner = state();
  let updates = 0;
  const ctx = {} as SessionContext;
  const progress = trackProgress(owner, "old", 1, ctx, () => {
    updates++;
  });
  owner.lifecycleGeneration++;
  progress({ content: [], details: details([makeRunningResult()]) });
  assert.equal(owner.activeSubagentUsageSummaries.size, 0);
  assert.equal(updates, 0);
});

test("interleaved unchanged nested heartbeats are not semantic activity and late events are ignored", () => {
  const result = makeRunningResult();
  const attempt = {
    resolved: false,
    receivedFirstEvent: true,
    agentSettled: false,
    startupTimedOut: false,
    wasAborted: false,
    activeToolCallIds: new Set(),
  } as AttemptState;
  let activity = 0;
  const handler = createProtocolHandler({
    state: attempt,
    result,
    promptRequestId: "prompt",
    emitUpdate() {},
    noteSemanticActivity() {
      activity++;
    },
    stopChild() {},
    doResolve() {},
    forceStopAndSettle() {},
  });
  const events = ["a", "b"].map((toolCallId) =>
    JSON.stringify({ type: "subagent_progress", toolCallId, details: details([]) }),
  );
  for (let i = 0; i < 1000; i++) events.forEach(handler);
  assert.equal(activity, 2);
  assert.equal(attempt.lastNestedProgressSignature, undefined, "do not retain a serialized tree on attempt state");
  attempt.resolved = true;
  handler(
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }] } }),
  );
  assert.equal(result.messages.length, 0);
});

test("throwing onHandle stops and settles a child instead of leaking it", { timeout: 5000 }, async () => {
  const result = makeRunningResult();
  const controller = new AbortController();
  const outcome = await runAttempt(
    {
      cwd: process.cwd(),
      agents: [],
      agentName: "worker",
      task: "task",
      parentDepth: 0,
      maxDepth: 3,
      parentAgentStack: [],
      preventCycles: false,
      makeDetails: details,
      signal: controller.signal,
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", "setInterval(() => {}, 1000)"] },
      startupTimeoutMsOverride: 0,
      idleTimeoutMsOverride: 0,
      terminationTimeoutMsOverride: 50,
      onHandle() {
        throw new Error("callback exploded");
      },
    },
    result,
    [],
    "task",
    0,
    () => {},
  );
  assert.equal(outcome.exitCode, 1);
  assert.match(result.errorMessage!, /callback exploded/);
  // Aborting a settled attempt must not resurrect termination timers.
  controller.abort();
});

test("async batches release finished transcripts but preserve output, errors, and subtree usage", async () => {
  const bulk = "private-transcript".repeat(10000);
  const child = makeResult({ name: "child", usage: { ...emptyUsage(), cost: 4 } });
  const result = makeResult({
    name: "parent",
    usage: { ...emptyUsage(), cost: 2 },
    messages: [
      { role: "toolResult", toolName: "subagents", details: buildSubagentDetails("single", "spawn", null, [child]) },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: bulk },
          { type: "text", text: "saved answer" },
        ],
      },
    ],
  });
  let snapshots = 0,
    original: SingleResult | undefined;
  const response = await executeParallelSubprocess(
    [{ agent: result.agent, task: result.task }],
    [],
    process.cwd(),
    0,
    3,
    [],
    false,
    undefined,
    (partial) => {
      snapshots++;
      assert.equal(partial.details.results[0].messages.length, 0);
    },
    details,
    [result],
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      compactCompletedResults: true,
      settings: {},
      onResult(_index, completed) {
        original = completed;
      },
    },
  );
  assert.equal(original, result, "the completion callback still receives the original result");
  assert.equal(response.details.results[0].messages.length, 0);
  assert.equal(response.details.results[0].subtreeUsageSummary?.costUsd, 6);
  assert.equal(response.details.results[0].finalOutput, "saved answer");
  assert.ok(response.content[0].text.includes("saved answer"));
  assert.ok(!JSON.stringify(response).includes(bulk));
  assert.equal(snapshots, 2);
  assert.equal(result.messages.length, 2, "never mutate the caller's saved result");
});
