import assert from "node:assert/strict";
import test from "node:test";
import { collectCombinedUsageStatusLine, collectLiveUsageSummary } from "../extension/usage.js";
import { slimDetailsForProgress } from "../extension/progress-details.js";
import { appendUniqueMessage } from "../runner/message-index.js";
import {
  buildLiveSubagentDetails,
  emptyUsage,
  getFinalOutput,
  getNestedSubagentResults,
  type SingleResult,
} from "../types.js";
import type { TranscriptMessage } from "../types/transcript.js";
import { makeResult, makeRunningResult } from "./helpers/results.js";

const details = (results: SingleResult[]) => buildLiveSubagentDetails("parallel", "spawn", null, results);
const worker = (i: number, exitCode = 0) =>
  makeResult({
    name: `worker-${i}`,
    task: `task-${i}`,
    sessionDir: `/workers/${i}`,
    startedAt: i,
    exitCode,
    usage: { ...emptyUsage(), cost: 1 },
  });

test("a thousand completions rebuild their launch once, not once per sibling", () => {
  const count = 1000;
  const launch = Object.assign(details(Array.from({ length: count }, (_, i) => worker(i, -1))), { asyncJobId: "job" });
  let usageReads = 0;
  const completed = Array.from({ length: count }, (_, i) => {
    const result = worker(i);
    Object.defineProperty(result, "usage", {
      get() {
        usageReads++;
        return { ...emptyUsage(), cost: 1 };
      },
    });
    return {
      role: "custom",
      customType: "subagent_completion",
      details: Object.assign(details([]), {
        results: [result],
        asyncJobId: "job",
        asyncTaskIndex: i,
      }),
    };
  });
  const source = [{ role: "toolResult", toolName: "subagents", toolCallId: "job", details: launch }, ...completed];
  const [nested] = getNestedSubagentResults(source);
  assert.equal(nested.details.usageSummary?.costUsd, count);
  assert.equal(nested.details.results.length, count);
  assert.equal(usageReads, count, "each completed worker is summarized once");
  assert.ok(
    launch.results.every((result) => result.exitCode === -1),
    "reconciliation must not mutate the transcript",
  );
});

test("indexed recovery prefers the latest successful matching execution and keeps task/start boundaries", () => {
  const pending = worker(1, -1);
  const history = [
    {
      role: "toolResult",
      toolName: "subagents",
      toolCallId: "job",
      details: Object.assign(details([pending]), { asyncJobId: "job" }),
    },
    ...[
      worker(1),
      { ...worker(1), finalOutput: "newest" },
      { ...worker(1), startedAt: 99, finalOutput: "different execution" },
      { ...worker(1), task: "different task", finalOutput: "wrong task" },
      { ...worker(1), exitCode: 1, finalOutput: "failed" },
    ].map((result) => ({ role: "custom", customType: "subagent_completion", details: details([result]) })),
  ];
  assert.equal(getNestedSubagentResults(history)[0].details.results[0].finalOutput, "newest");
  const noStart = { ...pending, startedAt: undefined };
  history[0].details.results = [noStart];
  assert.equal(getNestedSubagentResults(history)[0].details.results[0].finalOutput, "different execution");
});

test("append-only footer updates read old parent usage once and rebuild safely after reload", () => {
  let reads = 0;
  const entries: unknown[] = [];
  const ctx = { sessionManager: { getLeafId: () => entries.length, getEntries: () => [...entries] } };
  for (let i = 0; i < 1000; i++) {
    entries.push({
      type: "message",
      message: {
        role: "assistant",
        get usage() {
          reads++;
          return { input: 1, cost: { total: 1 } };
        },
      },
    });
    collectCombinedUsageStatusLine(ctx);
  }
  // The assistant usage getter is consulted for the value and turn-presence check.
  assert.equal(reads, 2000);
  assert.match(collectCombinedUsageStatusLine(ctx)!, /\$1000\.0000/);
  entries[entries.length - 1] = { type: "message", message: { role: "assistant", usage: { cost: 2 } } };
  entries.push({ type: "message", message: { role: "user" } });
  assert.match(collectCombinedUsageStatusLine(ctx)!, /\$1001\.0000/);
  assert.equal(reads, 3998, "a replaced tail must force a full rebuild");
});

test("switching session files on the same manager invalidates even an identical leaf ID", () => {
  let file = "first.jsonl";
  let entries = [{ type: "message", message: { role: "assistant", usage: { cost: 1 } } }];
  const ctx = {
    sessionManager: {
      getLeafId: () => "shared-leaf",
      getSessionFile: () => file,
      getEntries: () => [...entries],
    },
  };
  assert.match(collectCombinedUsageStatusLine(ctx)!, /\$1\.0000/);
  file = "second.jsonl";
  entries = [{ type: "message", message: { role: "assistant", usage: { cost: 2 } } }];
  assert.match(collectCombinedUsageStatusLine(ctx)!, /\$2\.0000/);
});

test("parent-only appends do not revisit durable subagent details", () => {
  let detailsReads = 0;
  const nested = details([worker(1)]);
  const entries: unknown[] = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagents",
        get details() {
          detailsReads++;
          return nested;
        },
      },
    },
  ];
  const ctx = { sessionManager: { getLeafId: () => entries.length, getEntries: () => [...entries] } };
  collectCombinedUsageStatusLine(ctx);
  const initialReads = detailsReads;
  for (let i = 0; i < 100; i++) {
    entries.push({ type: "message", message: { role: "assistant", usage: { cost: 1 } } });
    collectCombinedUsageStatusLine(ctx);
  }
  assert.equal(detailsReads, initialReads);
  assert.match(collectCombinedUsageStatusLine(ctx)!, /\$101\.0000/);
});

test("nested progress forwards async completions, identities, and partial sibling accounting", () => {
  const first = worker(1);
  const second = worker(2, -1);
  const launch = Object.assign(
    details([
      { ...first, exitCode: -1, usage: emptyUsage() },
      { ...second, usage: emptyUsage() },
    ]),
    { asyncJobId: "job" },
  );
  const completion = Object.assign(details([first]), { asyncJobId: "job", asyncTaskIndex: 0 });
  const parent = makeRunningResult({
    name: "parent",
    messages: [
      { role: "toolResult", toolName: "subagents", toolCallId: "job", details: launch },
      {
        role: "custom",
        customType: "subagent_completion",
        details: completion,
        content: "PRIVATE_BULK".repeat(10000),
      } as TranscriptMessage,
    ],
    liveNestedSubagents: { job: details([first, second]) },
  });
  const source = details([parent]);
  const before = collectLiveUsageSummary(source);
  const projected = slimDetailsForProgress(source);
  const again = slimDetailsForProgress(source);
  assert.equal(projected.results[0].messages[0], again.results[0].messages[0], "reuse finalized message projections");
  const json = JSON.stringify(projected);
  assert.ok(!json.includes("PRIVATE_BULK"));
  const wire = JSON.parse(json);
  const after = collectLiveUsageSummary(wire);
  assert.equal(before.costUsd, 2);
  assert.deepEqual(after, before);
  assert.deepEqual(JSON.parse(JSON.stringify(slimDetailsForProgress(wire))), wire, "another forwarding hop is stable");
});

test("identical completion text must not deduplicate different executions", () => {
  const messages: TranscriptMessage[] = [];
  const completion = (start: number) => ({
    role: "custom",
    customType: "subagent_completion",
    content: "finished: done",
    details: {
      asyncJobId: `job-${start}`,
      asyncTaskIndex: 0,
      results: [{ ...worker(1), startedAt: start }],
    },
  });
  assert.equal(appendUniqueMessage(messages, completion(1)), true);
  assert.equal(appendUniqueMessage(messages, completion(2)), true);
  assert.equal(appendUniqueMessage(messages, completion(1)), false);
  assert.equal(messages.length, 2);
});

test("live accounting inspects only newly appended transcript messages", () => {
  let reads = 0;
  const result = makeRunningResult();
  const live = details([result]);
  for (let i = 0; i < 1000; i++) {
    result.messages.push({
      get role() {
        reads++;
        return "user";
      },
    });
    collectLiveUsageSummary(live);
  }
  assert.equal(reads, 2000, "each new message is inspected once, not the whole transcript per update");
  result.messages.length = 0;
  result.messages.push({ role: "toolResult", toolName: "subagents", details: details([worker(1)]) });
  assert.equal(collectLiveUsageSummary(live).costUsd, 1, "truncation/replacement rebuilds the history index");
});

test("output lookup caches finalized append-only history without caching the fallback", () => {
  let reads = 0;
  const messages: TranscriptMessage[] = [];
  for (let i = 0; i < 1000; i++) {
    messages.push({
      get role() {
        reads++;
        return "user";
      },
    });
    assert.equal(getFinalOutput(messages, String(i)), String(i));
  }
  assert.equal(reads, 1000);
  messages.push({ role: "assistant", content: [{ type: "text", text: "answer" }] });
  assert.equal(getFinalOutput(messages), "answer");
  messages.push({ role: "user" });
  assert.equal(getFinalOutput(messages, "fallback"), "answer");
  messages.length = 0;
  assert.equal(getFinalOutput(messages, "reset"), "reset");
  messages.push({ role: "assistant", content: [{ type: "text", text: "" }] });
  assert.equal(getFinalOutput(messages, "fallback"), "");
});

test("last-output lookup does not copy or read an entire history", () => {
  const history = Array.from({ length: 10000 }, () => ({ role: "user" }));
  Object.defineProperty(history, 0, {
    get() {
      throw new Error("old history must not be read");
    },
  });
  history.push({ role: "assistant", content: [{ type: "text", text: "answer" }] } as never);
  assert.equal(getFinalOutput(history), "answer");
  assert.equal(
    getFinalOutput([null, false, 1, { role: "assistant", content: [null, { type: "text", text: "safe" }] }]),
    "safe",
  );
});
