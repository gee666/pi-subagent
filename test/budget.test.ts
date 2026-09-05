import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  budgetPrompt,
  configuredTotalBudget,
  createBudget,
  findPersistedBudget,
  readBudget,
  reserveSubagentBudgets,
  SUBAGENT_BUDGET_CUSTOM_TYPE,
} from "../budget.js";
import { workspace, task } from "./fixtures/budget.js";
import { rewriteLegacyBudget } from "./fixtures/budget-legacy.js";

describe("subagent budgets", () => {
  test("defaults to 50 and accepts only non-negative safe integer configuration", () => {
    const previous = process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS;
    delete process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS;
    try {
      assert.equal(configuredTotalBudget(), 50);
    } finally {
      if (previous !== undefined) process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS = previous;
    }
    assert.equal(configuredTotalBudget("0"), 0);
    assert.equal(configuredTotalBudget("120"), 120);
    for (const value of ["", "-1", "1.5", "no", "Infinity", "9007199254740992"]) {
      assert.throws(() => configuredTotalBudget(value), /Invalid PI_SUBAGENT_MAX_TOTAL_AGENTS/);
    }
  });

  test("shows the main agent only remaining allowances below 30", () => {
    const dir = workspace();
    try {
      for (const count of [0, 1, 2, 29, 30, 50, 1000]) {
        const budget = createBudget(path.join(dir, String(count)), count);
        const mainPrompt = budgetPrompt(budget, "main");
        if (count <= 1) {
          const expected =
            count === 0
              ? "You cannot launch subagents."
              : "You may launch one subagent and resume it as often as needed.";
          assert.equal(mainPrompt, expected);
          assert.equal(budgetPrompt(budget), expected);
          continue;
        }
        assert.match(budgetPrompt(budget), /Set max_agents_allowed on each task/);
        const limitPattern = new RegExp(`launch at most ${count} more`);
        if (count < 30) assert.match(mainPrompt, limitPattern);
        else assert.doesNotMatch(mainPrompt, limitPattern);
        assert.match(budgetPrompt(budget), limitPattern, "subagents always receive their allowance");
      }
      const budget = createBudget(path.join(dir, "remaining"), 1000);
      assert.throws(
        () => reserveSubagentBudgets(budget, "too-large", [task(1001)], "main"),
        (error: Error) => /budget exceeded/.test(error.message) && !/\b1000\b/.test(error.message),
      );
      assert.equal(readBudget(budget).remaining, 1000);
      reserveSubagentBudgets(budget, "assigned", [task(971)], "main");
      assert.match(budgetPrompt(budget, "main"), /launch at most 29 more/);
      assert.throws(() => reserveSubagentBudgets(budget, "too-many", [task(30)], "main"), /has 29 slots left/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reserves whole branches and rejects over-allocation without changing anything", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 8);
      const [a, b] = reserveSubagentBudgets(root, "first", [task(4), task(3)]);
      assert.deepEqual(readBudget(root), { limit: 8, remaining: 1 });
      assert.deepEqual(readBudget(a), { limit: 3, remaining: 3 });
      assert.deepEqual(readBudget(b), { limit: 2, remaining: 2 });
      assert.throws(() => reserveSubagentBudgets(a, "too-much", [task(2), task(2)]), /needs 4 slots.*has 3 slots left/);
      assert.equal(readBudget(a).remaining, 3);
      assert.equal(fs.existsSync(path.join(a.directory, "children")), false);
      const [nested] = reserveSubagentBudgets(a, "nested", [task(3)]);
      assert.equal(readBudget(a).remaining, 0);
      assert.equal(readBudget(b).remaining, 2);
      reserveSubagentBudgets(nested, "leaves", [task(), task()]);
      assert.equal(readBudget(nested).remaining, 0);
      assert.throws(() => reserveSubagentBudgets(a, "no-borrow", [task()]), /has 0 slots left/);
      assert.equal(readBudget(root).remaining, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("replays reservations without charging twice or resetting child budgets", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 3);
      const [child] = reserveSubagentBudgets(root, "first", [task(3)]);
      reserveSubagentBudgets(child, "work", [task()]);
      const restored = findPersistedBudget([{ type: "custom", customType: SUBAGENT_BUDGET_CUSTOM_TYPE, data: root }])!;
      assert.deepEqual(reserveSubagentBudgets(restored, "first", [task(3)]), [child]);
      assert.equal(readBudget(root).remaining, 0);
      assert.equal(readBudget(child).remaining, 1);
      assert.equal(budgetPrompt(child), "You may launch one subagent and resume it as often as needed.");
      createBudget(root.directory, 999);
      assert.equal(readBudget(root).limit, 3);
      assert.throws(() => reserveSubagentBudgets(root, "first", [task(1)]), /different budget/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing, zero, fractional, negative, and overflowing allowances", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 10);
      for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, "2", Number.MAX_SAFE_INTEGER]) {
        const invalidTask = task();
        Reflect.set(invalidTask, "max_agents_allowed", value);
        assert.throws(() => reserveSubagentBudgets(root, "bad", [invalidTask]));
      }
      assert.throws(
        () => reserveSubagentBudgets(root, "overflow", [task(Number.MAX_SAFE_INTEGER), task()]),
        /too large/,
      );
      assert.equal(readBudget(root).remaining, 10);
      const zero = createBudget(path.join(dir, "zero"), 0);
      assert.throws(() => reserveSubagentBudgets(zero, "new", [task()]), /has 0 slots left/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing or corrupt persisted ledgers block launches instead of minting a budget", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 3);
      const [child] = reserveSubagentBudgets(root, "first", [task(2)]);
      fs.rmSync(child.directory, { recursive: true, force: true });
      assert.throws(() => reserveSubagentBudgets(root, "first", [task(2)]), /Cannot read subagent budget/);
      fs.writeFileSync(path.join(root.directory, "state-1.json"), "broken");
      assert.throws(() => reserveSubagentBudgets(root, "second", [task()]), /allowance will not be reset/);
      assert.throws(
        () => findPersistedBudget([{ type: "custom", customType: SUBAGENT_BUDGET_CUSTOM_TYPE, data: {} }]),
        /Invalid saved/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a branch size of ten reserves exactly ten slots, including its worker", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 50);
      const [child] = reserveSubagentBudgets(root, "ten", [task(10)]);
      assert.equal(readBudget(root).remaining, 40);
      assert.equal(readBudget(child).remaining, 9);
      assert.match(budgetPrompt(child), /You may launch at most 9 more subagents/);
      assert.match(budgetPrompt(child), /Resuming an existing subagent uses no slot/);
      const leaves = reserveSubagentBudgets(
        child,
        "nine",
        Array.from({ length: 9 }, () => task(1)),
      );
      assert.equal(readBudget(child).remaining, 0);
      assert.ok(leaves.every((leaf) => readBudget(leaf).remaining === 0));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reads old exclusive reservations without charging again or resetting slots", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 5);
      const [child] = reserveSubagentBudgets(root, "old-call", [task(3)]);
      reserveSubagentBudgets(child, "work", [task(1)]);
      const file = path.join(root.directory, "state-1.json");
      rewriteLegacyBudget(file, 1);
      assert.deepEqual(reserveSubagentBudgets(root, "old-call", [task(3)]), [child]);
      assert.equal(readBudget(root).remaining, 2);
      assert.equal(readBudget(child).remaining, 1);
      reserveSubagentBudgets(root, "new-call", [task(2)]);
      assert.equal(readBudget(root).remaining, 0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root.directory, "state-2.json"), "utf8")).version, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renaming the inclusive argument preserves existing reservations", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 10);
      const [child] = reserveSubagentBudgets(root, "previous-name", [task(4)]);
      reserveSubagentBudgets(child, "used", [task(1)]);
      const file = path.join(root.directory, "state-1.json");
      rewriteLegacyBudget(file, 2);
      assert.deepEqual(reserveSubagentBudgets(root, "previous-name", [task(4)]), [child]);
      assert.equal(readBudget(root).remaining, 6);
      assert.equal(readBudget(child).remaining, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
