import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { createBudget, reserveSubagentBudgets, overrideResumeBudgets } from "../budget.js";
import { buildSubagentDetail, renderActivityLines, renderTurnOverviewLines } from "../detail.js";
import { readDetailBudget } from "../ui/detail-budget.js";
import type { SubagentNameRecord } from "../names.js";
import { settingsFixture } from "./helpers/settings.js";

function record(root: string, budget?: SubagentNameRecord["budget"]): SubagentNameRecord {
  return {
    name: "Roberto",
    agent: "",
    task: "Do work",
    ownerSessionId: "owner",
    createdAt: 1,
    sessionDir: path.join(root, "session"),
    forks: {},
    budget,
  };
}

test("expanded agent header shows allowance and slots used including reserved descendant caps", () => {
  const f = settingsFixture();
  try {
    const budget = createBudget(path.join(f.root, "budget"), 5);
    reserveSubagentBudgets(budget, "children", [
      { agent: "", task: "first", max_subagents_allowed: 0 },
      { agent: "", task: "second", max_subagents_allowed: 1 },
    ]);
    const detail = buildSubagentDetail(record(f.root, budget));
    assert.deepEqual(detail.budget, { allowed: 5, used: 3, remaining: 2 });
    for (const lines of [renderActivityLines(detail, 120), renderTurnOverviewLines(detail, 0, 120)]) {
      const screen = lines.join("\n");
      assert.match(screen, /Subagent budget: 5 allowed • 3 used\/reserved • 2 remaining/);
      assert.ok(screen.indexOf("Subagent budget:") < screen.indexOf("TASK"));
    }
  } finally {
    f.close();
  }
});

test("budget snapshots distinguish a zero allowance from unavailable legacy ledgers", () => {
  const f = settingsFixture();
  try {
    const zero = buildSubagentDetail(record(f.root, createBudget(path.join(f.root, "zero"), 0)));
    assert.deepEqual(zero.budget, { allowed: 0, used: 0, remaining: 0 });
    assert.match(renderActivityLines(zero, 120).join("\n"), /0 allowed • 0 used\/reserved • 0 remaining/);
    for (const budget of [undefined, { directory: path.join(f.root, "missing") }]) {
      const detail = buildSubagentDetail(record(f.root, budget));
      assert.equal(detail.budget, undefined);
      assert.match(renderActivityLines(detail, 120).join("\n"), /Subagent budget: unknown/);
    }
  } finally {
    f.close();
  }
});

test("reopening a detail reads the latest lifetime allowance instead of deriving a launch count", () => {
  const f = settingsFixture();
  try {
    const parent = createBudget(path.join(f.root, "parent"), 10);
    const [child] = reserveSubagentBudgets(parent, "child", [{ agent: "", task: "work", max_subagents_allowed: 2 }]);
    reserveSubagentBudgets(child, "grandchild", [{ agent: "", task: "work", max_subagents_allowed: 0 }]);
    assert.deepEqual(readDetailBudget(child), { allowed: 2, used: 1, remaining: 1 });
    overrideResumeBudgets(parent, [{ budget: child, max_subagents_allowed: 4 }]);
    assert.deepEqual(buildSubagentDetail(record(f.root, child)).budget, { allowed: 4, used: 1, remaining: 3 });
  } finally {
    f.close();
  }
});
