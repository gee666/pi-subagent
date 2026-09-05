import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectCombinedUsageStatusLine, collectLiveUsageSummary } from "../index.js";
import { buildSubagentDetails, emptyUsage, type SingleResult, type SubagentDetails } from "../types.js";
import { SUBAGENT_NAMES_CUSTOM_TYPE } from "../names.js";

function worker(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "worker", agentSource: "user", name: "Ada", task: "work",
    exitCode: 0, messages: [], stderr: "", usage: { ...emptyUsage(), cost: 2, turns: 1 },
    toolCalls: {}, completedTurns: 1, turnInProgress: false, liveLog: [],
    ...overrides,
  };
}

function details(result: SingleResult): SubagentDetails {
  return buildSubagentDetails("single", "spawn", null, [result]);
}

function entry(id: string, result: SingleResult, toolName = "subagents") {
  return {
    id, type: "message", message: {
      role: "toolResult", toolName, toolCallId: id,
      content: [], details: details(result),
    },
  };
}

function context(entries: any[]) {
  return { sessionManager: { getEntries: () => entries, getLeafId: () => entries.at(-1)?.id } };
}

test("resuming one named agent adds usage but not another agent", () => {
  const entries = [entry("launch", worker()), entry("resume", worker({ task: "follow up", usage: { ...emptyUsage(), cost: 3 } }), "resume_subagents")];
  const line = collectCombinedUsageStatusLine(context(entries))!;
  assert.match(line, /WITH SUBS: \(1\) Σ \$5\.0000/);
  const fork = entry("fork", worker({ name: "ADA", sessionDir: "/different/fork", usage: { ...emptyUsage(), cost: 1 } }), "resume_subagents");
  assert.match(collectCombinedUsageStatusLine(context([...entries, fork]))!, /\(1\) Σ \$6\.0000/);
});

test("live resume progress does not inflate the cached persisted count", () => {
  const ctx = context([entry("launch", worker())]);
  assert.match(collectCombinedUsageStatusLine(ctx)!, /\(1\) Σ \$2\.0000/);
  const live = collectLiveUsageSummary({
    ...details(worker()),
    results: [worker({ exitCode: -1, usage: { ...emptyUsage(), cost: 0.5 } })],
  });
  assert.match(collectCombinedUsageStatusLine(ctx, [live])!, /\(1\) Σ \$2\.5000/);
  const another = collectLiveUsageSummary(details(worker({ name: "Bo", usage: { ...emptyUsage(), cost: 1 } })));
  assert.match(collectCombinedUsageStatusLine(ctx, [live, another])!, /\(2\) Σ \$3\.5000/);
  assert.match(collectCombinedUsageStatusLine(ctx)!, /\(1\) Σ \$2\.0000/, "live merges must not mutate cached history");
});

test("nested resumes preserve unique identities through compact serialization", () => {
  const nestedLaunch = entry("nested", worker({ name: "Bo" }));
  const nestedResume = entry("nested-resume", worker({ name: "Bo", usage: { ...emptyUsage(), cost: 3 } }), "resume_subagents");
  const parent = worker({ usage: { ...emptyUsage(), cost: 1 }, messages: [nestedLaunch.message, nestedResume.message] as any });
  const durable = JSON.parse(JSON.stringify(details(parent)));
  assert.equal(durable.usageSummary.subagentCount, 2);
  assert.deepEqual(new Set(durable.usageSummary.subagentIds), new Set(["name:ada", "name:bo"]));
  const first = entry("parent", parent);
  first.message.details = durable;
  const later = entry("parent-resume", worker({
    usage: { ...emptyUsage(), cost: 1 },
    messages: [entry("child-again", worker({ name: "Bo", usage: { ...emptyUsage(), cost: 1 } }), "resume_subagents").message] as any,
  }), "resume_subagents");
  assert.match(collectCombinedUsageStatusLine(context([first, later]))!, /\(2\) Σ \$8\.0000/);
});

test("unnamed agents use stable budget or session identities, not their task text", () => {
  const first = worker({ name: undefined, budget: { directory: "/budget/first" }, sessionDir: "/sessions/first" });
  const resumedFork = worker({ ...first, sessionDir: "/sessions/private-fork" });
  assert.match(collectCombinedUsageStatusLine(context([
    entry("launch", first), entry("resume", resumedFork, "resume_subagents"),
  ]))!, /\(1\) Σ \$4\.0000/);
  const second = worker({ name: undefined, budget: undefined, sessionDir: "/sessions/second" });
  const third = worker({ ...second, sessionDir: "/sessions/third" });
  assert.match(collectCombinedUsageStatusLine(context([
    entry("one", second), entry("two", third), entry("one-again", second, "resume_subagents"),
  ]))!, /\(2\) Σ \$6\.0000/);
});

test("the name registry repairs legacy nested counts and refreshes without a new chat entry", () => {
  const root = path.join(process.cwd(), "tmp");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "unique-subagents-"));
  try {
    const file = path.join(dir, "names.json");
    const agents: Record<string, any> = { Ada: { sessionDir: "/sessions/ada" }, Bo: {}, Cy: {} };
    fs.writeFileSync(file, JSON.stringify({ version: 1, agents }));
    const first = entry("launch", worker());
    const resume = entry("resume", worker(), "resume_subagents");
    for (const item of [first, resume]) {
      item.message.details.usageSummary = {
        subagentCount: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheWriteTokens: 0, costUsd: 2, turns: 1,
      };
    }
    const identity = { type: "custom", customType: SUBAGENT_NAMES_CUSTOM_TYPE, data: { namesFile: file, ownerId: "root" } };
    const ctx = context([identity, first, resume]);
    assert.match(collectCombinedUsageStatusLine(ctx)!, /\(3\) Σ \$4\.0000/);
    agents.Dee = {};
    fs.writeFileSync(file, JSON.stringify({ version: 1, agents }));
    assert.match(collectCombinedUsageStatusLine(ctx)!, /\(4\) Σ \$4\.0000/);
    const oldUnnamed = entry("unnamed", worker({ name: undefined, sessionDir: "/sessions/ada" }));
    assert.match(collectCombinedUsageStatusLine(context([identity, oldUnnamed, resume]))!, /\(4\) Σ \$4\.0000/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
