import assert from "node:assert/strict";
import { test } from "node:test";
import { slimDetailsForProgress } from "../extension/progress-details.js";
import { buildSubagentDetails } from "../types.js";
import { nestedBroadcastHistory } from "../extension/broadcast-history.js";
import { collectRunningBroadcastTargetsFromResult, type BroadcastTarget } from "../extension/broadcast.js";
import { buildLiveSubagentDetails, type SingleResult } from "../types.js";
import type { TranscriptMessage } from "../types/transcript.js";
import { makeResult, makeRunningResult, makeToolResultMessage } from "./helpers/results.js";

const details = (...results: SingleResult[]) => buildLiveSubagentDetails("parallel", "spawn", null, results);

function collect(result: SingleResult) {
  const targets: { all: BroadcastTarget[]; youngest: BroadcastTarget[] } = { all: [], youngest: [] };
  collectRunningBroadcastTargetsFromResult(result, [result.name || result.agent], 1, targets);
  return targets;
}

test("routing tolerates omitted transcripts in serialized compact and progress refs", () => {
  assert.deepEqual(nestedBroadcastHistory(undefined), []);
  const child = makeRunningResult({ name: "Child", startedAt: 2 });
  const wire = JSON.parse(JSON.stringify(slimDetailsForProgress(details(child))));
  const compactRunning = JSON.parse(JSON.stringify(buildSubagentDetails("single", "spawn", null, [child])));
  assert.equal(compactRunning.results[0].messages, undefined);
  const root = makeRunningResult({ name: "Root", liveNestedSubagents: { task: compactRunning } });
  assert.doesNotThrow(() => collect(makeRunningResult({ name: "Progress", liveNestedSubagents: { task: wire } })));
  assert.deepEqual(
    collect(root).all.map((target) => target.display),
    ["Root > Child", "Root"],
  );
  const completed = JSON.parse(
    JSON.stringify(buildSubagentDetails("single", "spawn", null, [makeResult({ name: "Done" })])),
  );
  root.messages = [makeToolResultMessage("subagents", completed)];
  assert.doesNotThrow(() => collect(root));
  assert.deepEqual(
    collect(root).all.map((target) => target.display),
    ["Root > Child", "Root"],
  );
});

test("cached routing history inspects only appended messages after seeding 10000 assistant turns", (t) => {
  let roleReads = 0;
  const assistant = (): TranscriptMessage => ({
    get role() {
      roleReads++;
      return "assistant";
    },
    content: [],
  });
  const messages = Array.from({ length: 10000 }, assistant);
  const first = nestedBroadcastHistory(messages);
  assert.deepEqual(first, []);
  roleReads = 0;
  for (let i = 0; i < 1000; i++) nestedBroadcastHistory(messages);
  assert.equal(roleReads, 0);
  messages.push(assistant());
  assert.equal(nestedBroadcastHistory(messages), first);
  assert.ok(roleReads <= 2, "only the newly appended turn should be classified");
  t.diagnostic(`10000-turn history, 1000 unchanged updates: 0 role reads; appended assistant: ${roleReads} role reads`);
});

test("history cache reconciles async completions without rescanning unrelated assistant turns", () => {
  const child = makeRunningResult({ name: "Child", sessionDir: "/child", startedAt: 10 });
  const receipt = { ...makeToolResultMessage("subagents", { ...details(child), asyncJobId: "tc1" }) };
  const messages: TranscriptMessage[] = [receipt];
  assert.equal(nestedBroadcastHistory(messages)[0].details.results[0].exitCode, -1);
  const completion = {
    role: "custom",
    customType: "subagent_completion",
    content: [],
    details: { ...details({ ...child, exitCode: 0 }), asyncJobId: "tc1", asyncTaskIndex: 0 },
  };
  messages.push(completion);
  const reconciled = nestedBroadcastHistory(messages);
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0].details.results[0].exitCode, 0);
  messages.push({ role: "assistant", content: [] });
  assert.equal(nestedBroadcastHistory(messages), reconciled);
});

test("truncation, tail replacement, and a new history array reset cached routing", () => {
  const message = (name: string) => makeToolResultMessage("subagents", details(makeRunningResult({ name })));
  const messages = [message("Old"), message("Last")];
  assert.equal(nestedBroadcastHistory(messages).length, 2);
  messages.pop();
  assert.deepEqual(
    nestedBroadcastHistory(messages).map((nested) => nested.details.results[0].name),
    ["Old"],
  );
  messages[0] = message("Replacement");
  assert.deepEqual(
    nestedBroadcastHistory(messages).map((nested) => nested.details.results[0].name),
    ["Replacement"],
  );
  assert.deepEqual(
    nestedBroadcastHistory([message("Fresh")]).map((nested) => nested.details.results[0].name),
    ["Fresh"],
  );
  messages.length = 0;
  assert.deepEqual(nestedBroadcastHistory(messages), []);
});

test("live async snapshots supersede launch placeholders and retain nested activity metadata", () => {
  const placeholder = makeRunningResult({ name: "Child", startedAt: 1 });
  const grandchild = makeRunningResult({ name: "Grandchild", startedAt: 3, idle: true });
  const live = { ...placeholder, startedAt: 2, liveNestedSubagents: { grandchildren: details(grandchild) } };
  const root = makeRunningResult({
    name: "Root",
    startedAt: 0,
    messages: [makeToolResultMessage("subagents", { ...details(placeholder), asyncJobId: "tc1" })],
    liveNestedSubagents: { tc1: details(live) },
  });
  const targets = collect(root);
  assert.deepEqual(targets.all, [
    {
      display: "Root > Child > Grandchild",
      topLevelId: 1,
      restPath: ["Child", "Grandchild"],
      startedAt: 3,
      idle: true,
    },
    { display: "Root > Child", topLevelId: 1, restPath: ["Child"], startedAt: 2 },
    { display: "Root", topLevelId: 1, restPath: [], startedAt: 0 },
  ]);
  assert.deepEqual(targets.youngest, [targets.all[0]]);
});

test("completed durable children are not revived by a stale live snapshot", () => {
  const root = makeRunningResult({
    name: "Root",
    messages: [makeToolResultMessage("subagents", details(makeResult({ name: "Completed" })))],
    liveNestedSubagents: { tc1: details(makeRunningResult({ name: "Stale" })) },
  });
  assert.deepEqual(
    collect(root).all.map(({ display }) => display),
    ["Root"],
  );
});
