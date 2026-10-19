import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findLatestResumableSubagentCalls } from "../resume.js";
import { publishCompletion } from "../extension/completion.js";
import type { ExtensionState } from "../extension/state.js";
import { collectCombinedUsageStatusLine, collectLiveUsageSummary } from "../extension/usage.js";
import {
  buildLiveSubagentDetails,
  buildSubagentDetails,
  emptyUsage,
  getNestedSubagentResults,
  type SingleResult,
} from "../types.js";
import {
  assistantSubagentCall,
  assistantText,
  makeCtx,
  makeResult,
  subagentToolResult,
  tasks,
  userText,
} from "./fixtures/resume.js";
import { messageEntry } from "./helpers/extension.js";

function worker(index: number, cost = 0, overrides: Partial<SingleResult> = {}): SingleResult {
  return makeResult({
    ...tasks[index],
    name: index === 0 ? "Ada" : "Bo",
    sessionDir: `/workers/${index}`,
    startedAt: 100 + index,
    exitCode: -1,
    stopReason: undefined,
    errorMessage: undefined,
    stderr: "",
    usage: { ...emptyUsage(), cost, input: cost * 100, turns: cost },
    ...overrides,
  });
}

function launch(id = "launch", results = [worker(0), worker(1)]): SessionEntry[] {
  const details = Object.assign(buildSubagentDetails("parallel", "spawn", null, results), { asyncJobId: id });
  return [assistantSubagentCall(id), subagentToolResult(id, details, false)];
}

function completion(id: string, index: number, result = worker(index, index + 2, { exitCode: 0 })): SessionEntry {
  return messageEntry(
    {
      role: "custom",
      customType: "subagent_completion",
      content: "finished",
      display: true,
      details: Object.assign(buildSubagentDetails("single", "spawn", null, [result]), {
        asyncJobId: id,
        asyncTaskIndex: index,
      }),
      timestamp: Date.now(),
    },
    `completion-${id}-${index}-${result.startedAt}`,
  );
}

function messages(entries: SessionEntry[]) {
  return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

test("partial async completion preserves finished output and unfinished siblings across later conversation", () => {
  const entries = roundTrip([
    ...launch(),
    assistantText("I am doing other work."),
    completion("launch", 1),
    userText("Keep going."),
  ]);
  const plans = findLatestResumableSubagentCalls(makeCtx(entries));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].previousToolCallId, "launch");
  assert.deepEqual(
    plans[0].details?.results.map((result) => result.exitCode),
    [-1, 0],
  );
  assert.equal(plans[0].details?.results[1].name, "Bo");
  assert.deepEqual(findLatestResumableSubagentCalls(makeCtx([...entries, completion("launch", 0)])), []);
});

test("all unfinished async launches survive later turns, but legacy recovery remains tail-only", () => {
  const entries = [
    ...launch("first"),
    assistantText("More work"),
    ...launch("second", [worker(0, 0, { sessionDir: "/second/0" }), worker(1, 0, { sessionDir: "/second/1" })]),
    userText("Continue"),
  ];
  assert.deepEqual(
    findLatestResumableSubagentCalls(makeCtx(entries)).map((plan) => plan.previousToolCallId),
    ["first", "second"],
  );
  const legacy = [assistantSubagentCall("legacy"), subagentToolResult("legacy"), userText("Continue")];
  assert.deepEqual(findLatestResumableSubagentCalls(makeCtx(legacy)), []);
});

test("failed async completions remain recoverable and unrelated completion IDs cannot finish a launch", () => {
  const failed = worker(0, 2, { exitCode: 1, errorMessage: "failed" });
  const entries = [
    ...launch(),
    completion("unrelated", 1, worker(1, 3, { exitCode: 0, sessionDir: "/unrelated" })),
    completion("launch", 0, failed),
    assistantText("Later"),
  ];
  const [plan] = findLatestResumableSubagentCalls(makeCtx(entries));
  assert.deepEqual(
    plan.details?.results.map((result) => result.exitCode),
    [1, -1],
  );
});

test("a recovered batch does not reopen or duplicate the original async launch", () => {
  const entries = [...launch("original"), completion("original", 0), ...launch("recovery"), userText("Later")];
  assert.equal(findLatestResumableSubagentCalls(makeCtx(entries)).length, 1);
  entries.push(completion("recovery", 1));
  assert.deepEqual(findLatestResumableSubagentCalls(makeCtx(entries)), []);
});

test("durable completions replace only their worker in a live partial batch", () => {
  const entries = [...launch(), completion("launch", 0)];
  const live = collectLiveUsageSummary(
    buildLiveSubagentDetails("parallel", "spawn", null, [worker(0, 200, { exitCode: 0 }), worker(1, 3)]),
  );
  const ctx = makeCtx(entries);
  assert.match(collectCombinedUsageStatusLine(ctx, [live])!, /\(2\) Σ \$5\.0000/);
  assert.match(collectCombinedUsageStatusLine(ctx)!, /\(2\) Σ \$2\.0000/);
  assert.match(collectCombinedUsageStatusLine(ctx, [live])!, /\$5\.0000/, "cached totals must not be mutated");
  entries.push(completion("launch", 1));
  assert.match(collectCombinedUsageStatusLine(makeCtx(entries), [live])!, /\$5\.0000/);
});

test("the same worker resumed later adds cost, while duplicate progress for one execution does not", () => {
  const entries = [...launch(), completion("launch", 0), completion("launch", 1)];
  const resumed = worker(0, 4, { startedAt: 500 });
  const live = collectLiveUsageSummary(buildLiveSubagentDetails("single", "spawn", null, [resumed]));
  assert.match(collectCombinedUsageStatusLine(makeCtx(entries), [live, live])!, /\(2\) Σ \$9\.0000/);
  entries.push(completion("resume", 0, { ...resumed, exitCode: 0 }));
  assert.match(collectCombinedUsageStatusLine(makeCtx(entries), [live])!, /\(2\) Σ \$9\.0000/);
});

test("nested async placeholders retain live siblings without charging completed subtrees twice", () => {
  const child = worker(0, 2, { exitCode: 0 });
  child.messages = [
    {
      role: "toolResult",
      toolName: "subagents",
      toolCallId: "grandchild",
      content: [],
      details: buildSubagentDetails("single", "spawn", null, [
        worker(1, 5, {
          name: "Cy",
          sessionDir: "/grandchild",
          startedAt: 200,
          exitCode: 0,
        }),
      ]),
    },
  ];
  const nestedEntries = [...launch("nested"), completion("nested", 0, child)];
  const parent = worker(0, 1, {
    name: "Parent",
    sessionDir: "/parent",
    startedAt: 1,
    messages: messages(nestedEntries),
    liveNestedSubagents: {
      nested: buildLiveSubagentDetails("parallel", "spawn", null, [child, worker(1, 3)]),
    },
  });
  const liveDetails = buildLiveSubagentDetails("single", "spawn", null, [parent]);
  const summary = collectLiveUsageSummary(liveDetails);
  assert.equal(summary.costUsd, 11);
  assert.equal(summary.subagentCount, 4);
  assert.equal(collectLiveUsageSummary(roundTrip(liveDetails)).costUsd, 11);
  assert.equal(getNestedSubagentResults(messages(nestedEntries)).length, 1);
});

test("nested signature fallback cannot hide a later execution of the same task", () => {
  const previous = worker(0, 2, { exitCode: 0 });
  const parent = worker(1, 1, {
    name: "Parent",
    sessionDir: "/parent",
    startedAt: 1,
    messages: [
      {
        role: "toolResult",
        toolName: "subagents",
        toolCallId: "previous",
        content: [],
        details: buildSubagentDetails("single", "spawn", null, [previous]),
      },
    ],
    liveNestedSubagents: {
      next: buildLiveSubagentDetails("single", "spawn", null, [worker(0, 4, { startedAt: 500 })]),
    },
  });
  const summary = collectLiveUsageSummary(buildLiveSubagentDetails("single", "spawn", null, [parent]));
  assert.equal(summary.costUsd, 7);
  assert.equal(summary.subagentCount, 2);
});

test("replayed completed siblings contribute once to nested durable summaries", () => {
  const nested = [
    ...launch("original"),
    completion("original", 0),
    ...launch("recovery"),
    completion("recovery", 0),
    completion("recovery", 1),
  ];
  const parent = worker(0, 1, { name: "Parent", sessionDir: "/parent", messages: messages(nested) });
  assert.equal(buildSubagentDetails("single", "spawn", null, [parent]).usageSummary?.costUsd, 6);
});

test("completion publication records launch identity and ignores replaced sessions", async () => {
  const sent: unknown[] = [];
  const state = {
    sessionActive: true,
    lifecycleGeneration: 1,
    scheduledTasks: new Set(),
    pi: { sendMessage: (message: unknown) => sent.push(message) },
  } as unknown as ExtensionState;
  publishCompletion(state, worker(1, 3, { exitCode: 0 }), 1, { jobId: "launch", taskIndex: 1 });
  await delay(20);
  assert.equal(sent.length, 1);
  const persisted = roundTrip(sent[0]) as { details: { asyncJobId: string; asyncTaskIndex: number } };
  assert.equal(persisted.details.asyncJobId, "launch");
  assert.equal(persisted.details.asyncTaskIndex, 1);
  publishCompletion(state, worker(0), 0, { jobId: "stale", taskIndex: 0 });
  publishCompletion(state, worker(0), 1);
  state.lifecycleGeneration++;
  await delay(20);
  assert.equal(sent.length, 1);
});
