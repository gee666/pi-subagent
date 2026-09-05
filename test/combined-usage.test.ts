import assert from "node:assert/strict";
import test from "node:test";

import { collectCombinedUsageStatusLine } from "../index.js";
import { filterPickerItems } from "../overlay.js";

const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total: cost },
});

function makeCtx<T extends { id: string; branch?: string }>(entries: T[]) {
  return {
    sessionManager: {
      getEntries: () => entries,
      getLeafId: () => entries[entries.length - 1]?.id,
      getBranch: (leafId: string) => entries.filter((entry) => entry.branch !== "abandoned" || entry.id === leafId),
    },
  };
}

test("combined usage counts every billed parent entry, like Pi's own footer", () => {
  const entries = [
    // On-branch assistant turn.
    { id: "a1", type: "message", message: { role: "assistant", provider: "anthropic", usage: usage(100, 10, 1) } },
    // Abandoned branch (retry/abort) — still billed, so it must be counted.
    {
      id: "a2",
      branch: "abandoned",
      type: "message",
      message: { role: "assistant", provider: "anthropic", usage: usage(200, 20, 2) },
    },
    // Compacted-away history usage.
    { id: "c1", type: "compaction", usage: usage(50, 5, 0.5) },
    // Non-subagent tool-side usage (summaries).
    { id: "t1", type: "message", message: { role: "toolResult", toolName: "web_search", usage: usage(10, 1, 0.25) } },
  ];

  const line = collectCombinedUsageStatusLine(makeCtx(entries));
  assert.ok(line, "expected a status line");
  assert.match(line!, /\$3\.7500/);
  assert.match(line!, /↑360/);
});

test("subagent cost is added once and never makes the combined total smaller", () => {
  const parentOnly = [
    { id: "a1", type: "message", message: { role: "assistant", provider: "anthropic", usage: usage(1000, 100, 5) } },
  ];
  const withSubagent = [
    ...parentOnly,
    {
      id: "t1",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagents",
        // A future Pi could also stamp usage here; it must NOT be double counted.
        usage: usage(400, 40, 2),
        details: {
          mode: "parallel",
          delegationMode: "spawn",
          results: [],
          usageSummary: {
            subagentCount: 1,
            inputTokens: 400,
            outputTokens: 40,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 2,
            turns: 3,
          },
        },
      },
    },
  ];

  const parentLine = collectCombinedUsageStatusLine(makeCtx(parentOnly))!;
  const combinedLine = collectCombinedUsageStatusLine(makeCtx(withSubagent))!;

  assert.match(parentLine, /\(0\) Σ \$5\.0000/);
  // 5 (parent) + 2 (subagent), counted exactly once.
  assert.match(combinedLine, /\(1\) Σ \$7\.0000/);

  const cost = (line: string) => Number(/\$(\d+\.\d+)/.exec(line)![1]);
  assert.ok(cost(combinedLine) > cost(parentLine), "combined must never be cheaper than the parent alone");
});

test("picker search matches by name fragment, agent type, and task", () => {
  const items = [
    { name: "Carolyn", agent: "team-lead", task: "inspect repository" },
    { name: "Jayavarman", agent: "code-reviwer", task: "review the plan" },
    { name: "Natalie", agent: "code-reviwer", task: "check tests" },
  ];
  // Fuzzy search ranks the best match first rather than requiring a prefix.
  assert.equal(filterPickerItems(items, "rol")[0].name, "Carolyn");
  assert.equal(
    filterPickerItems(items, "caro")
      .map((item) => item.name)
      .join(),
    "Carolyn",
  );
  assert.deepEqual(
    filterPickerItems(items, "reviwer")
      .map((item) => item.name)
      .sort(),
    ["Jayavarman", "Natalie"],
  );
  assert.ok(filterPickerItems(items, "tests").some((item) => item.name === "Natalie"));
  assert.equal(filterPickerItems(items, "").length, 3);
  assert.equal(filterPickerItems(items, "zzzz").length, 0);
});
