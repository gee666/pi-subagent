import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBudget, readBudget, reservedSubagentBudgets, reserveSubagentBudgets } from "../budget.js";
import type { ResumableSubagentCall } from "../resume.js";
import { launchBudgets } from "../extension/launch-budgets.js";
import { createExtensionState } from "../extension/state.js";
import { buildSubagentDetails } from "../types.js";
import { hostDouble } from "./helpers/extension.js";
import { makeResult } from "./helpers/results.js";

const tasks = ["a", "b", "c"].map((task) => ({ agent: "worker", task, max_subagents_allowed: 2 }));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-launch-budgets-"));
  const state = createExtensionState(hostDouble<ExtensionAPI>({ getFlag: () => undefined }));
  state.currentBudget = createBudget(path.join(root, "budget"), 20);
  const plan = (indexes: number[], budgets: boolean): ResumableSubagentCall => ({
    previousToolCallId: "original",
    tasks: indexes.map((index) => tasks[index]),
    taskIndexes: indexes,
    details: buildSubagentDetails(
      "parallel",
      "spawn",
      null,
      indexes.map((index) =>
        makeResult({ exitCode: -1, budget: budgets ? { directory: `/recorded/${index}` } : undefined }),
      ),
    ),
  });
  const runnable = (indexes: number[]) => indexes.map((index, position) => ({ index: position, task: tasks[index] }));
  return { root, state, plan, runnable, dir: (index: number) => path.join(root, "slots", String(index)) };
}

test("recovery matches missing grants to the original reservation without charging again", () => {
  const f = fixture();
  try {
    const grants = reserveSubagentBudgets(f.state.currentBudget!, "original", tasks, "main");
    const remaining = readBudget(f.state.currentBudget!).remaining;
    const mixed = f.plan([1, 2], false);
    mixed.details!.results[0].budget = { directory: "/recorded/1" };
    assert.deepEqual(launchBudgets(f.state, "recovery", 2, f.runnable([1, 2]), mixed, f.dir), [
      { directory: "/recorded/1" },
      grants[2],
    ]);
    assert.equal(readBudget(f.state.currentBudget!).remaining, remaining);
    assert.equal(reservedSubagentBudgets(f.state.currentBudget!, "recovery"), undefined);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("an unmatched grant gets no descendant allowance rather than a second charge", () => {
  const f = fixture();
  try {
    reserveSubagentBudgets(f.state.currentBudget!, "original", [tasks[0]], "main");
    const remaining = readBudget(f.state.currentBudget!).remaining;
    const [budget] = launchBudgets(f.state, "recovery", 1, f.runnable([2]), f.plan([2], false), f.dir);
    assert.equal(budget?.directory, path.join(f.dir(0), "legacy-budget"));
    assert.equal(readBudget(budget!).limit, 0);
    assert.equal(readBudget(f.state.currentBudget!).remaining, remaining);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("a launch interrupted before reserving reserves once under its original call", () => {
  const f = fixture();
  try {
    const budgets = launchBudgets(f.state, "recovery", 3, f.runnable([0, 1, 2]), f.plan([0, 1, 2], false), f.dir);
    assert.deepEqual(budgets, reservedSubagentBudgets(f.state.currentBudget!, "original")?.children);
    assert.equal(readBudget(f.state.currentBudget!).remaining, 20 - 9);
    assert.equal(reservedSubagentBudgets(f.state.currentBudget!, "recovery"), undefined);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
