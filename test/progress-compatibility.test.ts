import assert from "node:assert/strict";
import { test } from "node:test";
import { slimDetailsForProgress } from "../extension/progress.js";
import { collectLiveUsageSummary } from "../extension/usage.js";
import { collectRunningBroadcastTargetsFromResult, type BroadcastTarget } from "../extension/broadcast.js";
import { processJsonLine } from "../runner/events.js";
import { priorDescendantUsage } from "../runner/result.js";
import {
  buildLiveSubagentDetails,
  buildSubagentDetails,
  emptyUsage,
  isSubagentDetails,
  subagentIdentity,
  usageSummaryFromUsage,
  type SingleResult,
  type SubagentDetails,
} from "../types.js";
import type { TranscriptMessage } from "../types/transcript.js";
import { buildTopLevelNodes } from "../ui/tree-build.js";
import { countNodes, topLevelSummary } from "../ui/tree-format.js";
import { makeResult, makeRunningResult } from "./helpers/results.js";

const details = (...results: SingleResult[]) =>
  buildLiveSubagentDetails(results.length > 1 ? "parallel" : "single", "spawn", null, results);
const worker = (name: string, cost = 1, extra: Partial<SingleResult> = {}) =>
  makeRunningResult({ agent: "worker", name, task: "same task", usage: { ...emptyUsage(), cost }, ...extra });

function call(toolName: string, id: string, args: Record<string, unknown>, legacyId = false): TranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", name: toolName, ...(legacyId ? { toolCallId: id } : { id }), arguments: args }],
  };
}

function completed(toolName: string, id: string, nested: SubagentDetails, isError = false): TranscriptMessage {
  return { role: "toolResult", toolName, toolCallId: id, details: nested, isError, content: [] };
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function wire(value: SubagentDetails): SubagentDetails {
  const result = roundTrip(slimDetailsForProgress(value));
  assert.ok(isSubagentDetails(result));
  return result;
}

const nodes = (value: SubagentDetails) => buildTopLevelNodes(value, { hydrateSessions: false });

function targets(value: SubagentDetails) {
  const result: { all: BroadcastTarget[]; youngest: BroadcastTarget[] } = { all: [], youngest: [] };
  value.results.forEach((child, index) =>
    collectRunningBroadcastTargetsFromResult(child, [child.name || child.agent], 7 + index, result),
  );
  return result;
}

test("JSONL progress preserves nested completed/live trees, labels, outcomes and activity", () => {
  const leaf = worker("Dee", 4, {
    intelligence: "junior",
    startedAt: 1000,
    lastActionAt: 3000,
    model: "test-model",
    liveLog: [{ kind: "tool_start", at: 3000, toolName: "edit", args: { path: "/repo/a.ts" } }],
  });
  const live = worker("Cy", 3, {
    messages: [call("resume_subagents", "resume", { resumes: { subagent: "Dee", task: "same task" } })],
    liveNestedSubagents: { resume: details(leaf) },
  });
  const done = worker("Bo", 2, {
    task: "earlier task",
    exitCode: 1,
    stopReason: "length",
    errorMessage: "incomplete",
    finalOutput: "done",
  });
  const parent = worker("Ada", 1, {
    messages: [
      call("subagent", "old", { tasks: [{ agent: "worker", task: "earlier task" }] }, true),
      completed("subagent", "old", details(done), true),
      call("subagents", "current", { tasks: [{ agent: "worker", task: "same task" }] }),
    ],
    liveNestedSubagents: { current: details(live) },
  });
  const source = details(parent);
  const receiver = makeRunningResult();
  assert.equal(
    processJsonLine(
      JSON.stringify({ type: "subagent_progress", toolCallId: "outer", details: wire(source) }),
      receiver,
    ),
    true,
  );
  assert.deepEqual(receiver.messages, [], "progress must remain transient");
  const received = receiver.liveNestedSubagents?.outer;
  assert.ok(received);
  assert.deepEqual(nodes(received), nodes(source));
  const tree = nodes(received)[0];
  assert.equal(tree.children[0].status, "error");
  assert.match(tree.children[1].children[0].label, /Dee/);
  assert.deepEqual(collectLiveUsageSummary(received), collectLiveUsageSummary(source));
});

test("task signature fallback keeps long distinct tasks exact when IDs differ and live order is reversed", () => {
  const taskA = "shared prefix ".repeat(100) + "A";
  const taskB = "shared prefix ".repeat(100) + "B";
  const parent = worker("Ada", 1, {
    messages: [
      call("subagents", "call-a", { tasks: [{ agent: "worker", task: taskA }] }),
      call("subagents", "call-b", { tasks: [{ agent: "worker", task: taskB }] }),
    ],
    liveNestedSubagents: {
      "different-b": details(worker("Bo", 2, { task: taskB })),
      "different-a": details(worker("Cy", 3, { task: taskA })),
    },
  });
  const projected = wire(details(parent));
  assert.deepEqual(nodes(projected), nodes(details(parent)));
  assert.deepEqual(
    nodes(projected)[0].children.map((child) => child.label),
    ["Cy (worker)", "Bo (worker)"],
  );
  assert.deepEqual(
    nodes(projected)[0].children.map((child) => child.task),
    [taskA, taskB],
  );
});

test("repeated completed/live task signatures deduplicate as a multiset, not a set", () => {
  const savedBo = buildSubagentDetails("single", "spawn", null, [worker("Bo", 2, { exitCode: 0 })]);
  const savedCy = buildSubagentDetails("single", "spawn", null, [worker("Cy", 3, { exitCode: 0 })]);
  const source = details(
    worker("Ada", 1, {
      messages: [completed("subagents", "done-bo", savedBo), completed("subagents", "done-cy", savedCy)],
      liveNestedSubagents: {
        "stale-bo": details(worker("Bo", 100)),
        "stale-cy": details(worker("Cy", 200)),
        "still-running": details(worker("Dee", 4)),
      },
    }),
  );
  const expected = collectLiveUsageSummary(source);
  assert.equal(expected.costUsd, 10);
  assert.equal(expected.subagentCount, 4);
  assert.deepEqual(collectLiveUsageSummary(wire(source)), expected);
});

test("completed toolCallId wins over stale live details even with a different task signature", () => {
  const source = details(
    worker("Ada", 1, {
      messages: [completed("subagents", "done", details(worker("Bo", 2, { exitCode: 0 })))],
      liveNestedSubagents: { done: details(worker("Bo", 100, { task: "stale task" })) },
    }),
  );
  assert.equal(collectLiveUsageSummary(wire(source)).costUsd, 3);
  assert.deepEqual(collectLiveUsageSummary(wire(source)), collectLiveUsageSummary(source));
});

test("subtree summaries take precedence and resume descendant baselines survive projection", () => {
  const own = worker("Ada", 1);
  const subtree = usageSummaryFromUsage({ ...emptyUsage(), cost: 7, input: 70, turns: 7 }, "name:ada");
  subtree.subagentCount = 2;
  subtree.subagentIds = ["name:ada", "name:bo"];
  const prior = usageSummaryFromUsage({ ...emptyUsage(), cost: 6, input: 60, turns: 6 }, "name:bo");
  const source = details({
    ...own,
    subtreeUsageSummary: subtree,
    priorDescendantUsageSummary: prior,
    liveNestedSubagents: { ignored: details(worker("Cy", 100)) },
  });
  const projected = wire(source);
  assert.deepEqual(collectLiveUsageSummary(projected), subtree);
  assert.deepEqual(priorDescendantUsage(projected.results[0]), priorDescendantUsage(source.results[0]));
  const resumed = details({
    ...own,
    priorDescendantUsageSummary: prior,
    liveNestedSubagents: { fresh: details(worker("Dee", 2)) },
  });
  const total = collectLiveUsageSummary(wire(resumed));
  assert.equal(total.costUsd, 9);
  assert.equal(total.subagentCount, 3);
  assert.deepEqual(total, collectLiveUsageSummary(resumed));
});

test("details usageSummary wins over conflicting own/aggregate totals for headers and completed accounting", () => {
  const nested = details(worker("Bo", 100, { exitCode: 0 }));
  nested.usageSummary = usageSummaryFromUsage(
    { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cost: 7, contextTokens: 99, turns: 4 },
    "name:bo",
  );
  const projected = wire(nested);
  assert.deepEqual(projected.usageSummary, nested.usageSummary);
  assert.equal(
    topLevelSummary(projected, countNodes(nodes(projected))),
    topLevelSummary(nested, countNodes(nodes(nested))),
  );
  assert.match(topLevelSummary(projected, countNodes(nodes(projected))), /\$7\.0000/);
  const parent = details(worker("Ada", 1, { messages: [completed("subagents", "done", nested)] }));
  const total = collectLiveUsageSummary(wire(parent));
  assert.deepEqual(total, collectLiveUsageSummary(parent));
  assert.equal(total.costUsd, 8);
  assert.equal(total.inputTokens, 11);
  assert.equal(total.outputTokens, 7);
  assert.equal(total.cacheReadTokens, 3);
  assert.equal(total.cacheWriteTokens, 2);
  assert.equal(total.turns, 4);
});

test("identity precedence remains name, budget directory, session directory, session ID", () => {
  const identities: Array<[Partial<SingleResult>, string]> = [
    [{ name: "ADA", budget: { directory: "/budget" }, sessionDir: "/fork", sessionId: "id" }, "name:ada"],
    [{ budget: { directory: "/budget" }, sessionDir: "/fork", sessionId: "id" }, "budget:/budget"],
    [{ sessionDir: "/session", sessionId: "id" }, "session:/session"],
    [{ sessionId: "id" }, "session-id:id"],
  ];
  for (const [identity, expected] of identities) {
    const child = makeRunningResult({ ...identity, usage: { ...emptyUsage(), cost: 1 } });
    const source = details(child, { ...child, sessionDir: child.sessionDir ? "/private-fork" : undefined });
    const projected = wire(source);
    assert.equal(subagentIdentity(projected.results[0]), expected);
    const total = collectLiveUsageSummary(projected);
    assert.deepEqual(total, collectLiveUsageSummary(source));
    assert.equal(total.costUsd, 2);
    assert.equal(total.subagentCount, expected.startsWith("session:") ? 2 : 1);
  }
});

test("broadcast paths, top-level ordering, youngest targets and completed-ID precedence survive", () => {
  const live = worker("Bo", 2, { liveNestedSubagents: { deeper: details(worker("Cy", 3)) } });
  const source = details(
    worker("Ada", 1, {
      messages: [completed("subagent", "done", details(worker("Old", 2, { exitCode: 0 })))],
      liveNestedSubagents: { done: details(worker("Old", 100)), live: details(live) },
    }),
    worker("Dee", 4),
  );
  const projectedTargets = targets(wire(source));
  assert.deepEqual(projectedTargets, targets(source));
  assert.deepEqual(
    projectedTargets.all.map(({ display, topLevelId, restPath }) => [display, topLevelId, restPath]),
    [
      ["Ada > Bo > Cy", 7, ["Bo", "Cy"]],
      ["Ada > Bo", 7, ["Bo"]],
      ["Ada", 7, []],
      ["Dee", 8, []],
    ],
  );
  assert.deepEqual(
    projectedTargets.youngest.map((target) => target.display),
    ["Ada > Bo > Cy", "Dee"],
  );
});

for (const toolName of ["subagent", "subagents", "resume_subagents"]) {
  for (const objectResume of toolName === "resume_subagents" ? [false, true] : [false]) {
    test(`${toolName} ${objectResume ? "object" : "array"} arguments retain pending and completed tree nodes`, () => {
      const launch = [{ agent: "worker", name: "Bo", intelligence: "junior", task: "same task" }];
      const resumes = [{ name: "Bo", prompt: "same task" }];
      const args =
        toolName === "resume_subagents" ? { resumes: objectResume ? resumes[0] : resumes } : { tasks: launch };
      const pending = worker("Ada", 1, { messages: [call(toolName, "call", args, toolName === "subagent")] });
      assert.deepEqual(nodes(wire(details(pending))), nodes(details(pending)));
      assert.equal(nodes(wire(details(pending)))[0].children.length, 1);
      const settled = {
        ...pending,
        messages: [
          ...pending.messages,
          completed(toolName, "call", details(worker("Bo", 2, { exitCode: 0, finalOutput: "complete" }))),
        ],
      };
      assert.deepEqual(nodes(wire(details(settled))), nodes(details(settled)));
      assert.equal(nodes(wire(details(settled)))[0].children[0].status, "success");
    });
  }
}

test("default-agent launch tasks without an agent keep pending nodes and exact task text", () => {
  const source = details(
    makeResult({ exitCode: -1, messages: [call("subagents", "default", { tasks: [{ task: "untyped work" }] })] }),
  );
  const projected = wire(source);
  assert.deepEqual(nodes(projected), nodes(source));
  assert.equal(nodes(projected)[0].children[0].task, "untyped work");
});

test("JSON durable input without messages preserves summaries, identity, resume baseline and output", () => {
  const child = worker("Bo", 2, { exitCode: 0 });
  const parent = worker("Ada", 1, {
    exitCode: 130,
    stopReason: "aborted",
    finalOutput: "saved output",
    budget: { directory: "/budget" },
    sessionDir: "/session",
    sessionId: "saved-id",
    messages: [completed("subagents", "child", buildSubagentDetails("single", "spawn", null, [child]))],
  });
  const durable = roundTrip(buildSubagentDetails("single", "spawn", null, [parent]));
  assert.equal(durable.results[0].messages, undefined);
  const projected = wire(durable);
  assert.deepEqual(projected.results[0].messages, []);
  assert.deepEqual(projected.usageSummary, durable.usageSummary);
  assert.deepEqual(projected.results[0].subtreeUsageSummary, durable.results[0].subtreeUsageSummary);
  assert.deepEqual(collectLiveUsageSummary(projected), collectLiveUsageSummary(durable));
  assert.deepEqual(priorDescendantUsage(projected.results[0]), priorDescendantUsage(durable.results[0]));
  assert.deepEqual(nodes(projected), nodes(durable));
  assert.equal(projected.results[0].finalOutput, "saved output");
  assert.equal(subagentIdentity(projected.results[0]), "name:ada");
});

test("legacy details without aggregate fields retain the renderer's own-usage fallback", () => {
  const source = details(worker("Ada", 2));
  Reflect.deleteProperty(source, "aggregatedUsage");
  const before = topLevelSummary(source, countNodes(nodes(source)));
  assert.match(before, /\$2\.0000/);
  const projected = wire(source);
  assert.equal(topLevelSummary(projected, countNodes(nodes(projected))), before);
});
