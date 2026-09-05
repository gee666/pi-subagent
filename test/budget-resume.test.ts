import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createBudget, readBudget, reserveSubagentBudgets, overrideResumeBudgets } from "../budget.js";
import { workspace, task } from "./fixtures/budget.js";

describe("subagent budget resume overrides", () => {
  test("resume overrides change lifetime caps without resetting spending or charging twice", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 10);
      const [child] = reserveSubagentBudgets(root, "first", [task(3)]);
      reserveSubagentBudgets(child, "used", [task(1)]);
      overrideResumeBudgets(root, [{ budget: child, max_agents_allowed: 5 }]);
      assert.equal(readBudget(root).remaining, 5);
      assert.deepEqual(readBudget(child), { limit: 4, remaining: 3 });
      overrideResumeBudgets(root, [{ budget: child, max_agents_allowed: 3 }]);
      assert.deepEqual(readBudget(child), { limit: 2, remaining: 1 });
      assert.equal(readBudget(root).remaining, 5, "lowering does not refund reserved capacity");
      overrideResumeBudgets(root, [{ budget: child, max_agents_allowed: 5 }]);
      assert.equal(readBudget(root).remaining, 5, "restoring a funded cap is free");
      assert.equal(readBudget(child).remaining, 3);
      assert.deepEqual(reserveSubagentBudgets(root, "first", [task(3)]), [child], "original launch remains replayable");
      assert.throws(
        () => overrideResumeBudgets(root, [{ budget: child, max_agents_allowed: 1 }]),
        /already needs 2 slots/,
      );
      assert.equal(readBudget(child).remaining, 3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects unaffordable batches, unrelated overrides, and shrinking assigned slots", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 5);
      const [a, b] = reserveSubagentBudgets(root, "first", [task(2), task(2)]);
      assert.throws(
        () =>
          overrideResumeBudgets(root, [
            { budget: a, max_agents_allowed: 3 },
            { budget: b, max_agents_allowed: 3 },
          ]),
        /needs 2 extra slots/,
      );
      assert.equal(readBudget(root).remaining, 1);
      assert.equal(readBudget(a).limit, 1);
      assert.equal(readBudget(b).limit, 1);
      assert.throws(
        () => overrideResumeBudgets(a, [{ budget: b, max_agents_allowed: 3 }]),
        /outside your own delegation tree/,
      );
      reserveSubagentBudgets(a, "used", [task(1)]);
      assert.throws(() => overrideResumeBudgets(root, [{ budget: a, max_agents_allowed: 1 }]), /already needs 2 slots/);
      for (const invalid of [0, -1, 1.5, NaN]) {
        assert.throws(
          () => overrideResumeBudgets(root, [{ budget: b, max_agents_allowed: invalid }]),
          /positive safe integer/,
        );
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an ancestor can override nested workers using their original launcher's slots", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 10);
      const [parent] = reserveSubagentBudgets(root, "parent", [task(6)]);
      const [child] = reserveSubagentBudgets(parent, "child", [task(1)]);
      overrideResumeBudgets(root, [{ budget: child, max_agents_allowed: 4 }]);
      assert.equal(readBudget(root).remaining, 4);
      assert.equal(readBudget(parent).remaining, 1);
      assert.equal(readBudget(child).remaining, 3);
      assert.throws(
        () =>
          overrideResumeBudgets(root, [
            { budget: parent, max_agents_allowed: 7 },
            { budget: child, max_agents_allowed: 5 },
          ]),
        /same original launcher/,
      );
      assert.equal(readBudget(root).remaining, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
