import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createBudget, readBudget, reserveSubagentBudgets } from "../budget.js";
import { workspace, task, race } from "./fixtures/budget.js";

describe("concurrent subagent budgets", () => {
  test("concurrent resume increases reserve extra capacity only once", { timeout: 30_000 }, async () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "budget"), 4);
      const [child] = reserveSubagentBudgets(root, "first", [task(1)]);
      const ids = Array.from({ length: 6 }, (_, index) => `resize-${index}`);
      const results = await race(
        dir,
        ids,
        ids.map(() => ({ override: { budget: child, max_agents_allowed: 4 } })),
      );
      assert.ok(results.every((result) => result.ok));
      assert.equal(readBudget(root).remaining, 0);
      assert.equal(readBudget(child).remaining, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a concurrent launch and conflicting decrease cannot both succeed", { timeout: 30_000 }, async () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "budget"), 5);
      const [child] = reserveSubagentBudgets(root, "first", [task(3)]);
      const results = await race(
        dir,
        ["decrease", "launch"],
        [{ override: { budget: child, max_agents_allowed: 1 } }, { reserveBudget: child }],
      );
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(readBudget(child).remaining, 0);
      assert.equal(readBudget(root).remaining, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parallel processes cannot reserve the same remaining slots", { timeout: 30_000 }, async () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "budget"), 8);
      const results = await race(
        dir,
        Array.from({ length: 8 }, (_, i) => `call-${i}`),
      );
      assert.equal(results.filter((result) => result.ok).length, 4);
      assert.equal(readBudget(root).remaining, 0);
      for (const result of results.filter((result) => !result.ok)) assert.match(result.error!, /budget exceeded/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parallel retries of one call share one reservation", { timeout: 30_000 }, async () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "budget"), 2);
      const results = await race(
        dir,
        Array.from({ length: 6 }, () => "same-call"),
      );
      assert.ok(results.every((result) => result.ok));
      assert.equal(readBudget(root).remaining, 0);
      assert.equal(fs.readdirSync(path.join(root.directory, "children")).length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
