import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fork } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  budgetPrompt, configuredTotalBudget, createBudget, findPersistedBudget,
  readBudget, reserveSubagentBudgets, overrideResumeBudgets, SUBAGENT_BUDGET_CUSTOM_TYPE,
  type BudgetTask,
} from "../budget.js";

function workspace(): string {
  const root = path.join(process.cwd(), "tmp");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "budget-test-"));
}

function task(max_agents_allowed = 1): BudgetTask {
  return { agent: "worker", task: "work", max_agents_allowed };
}

async function race(directory: string, ids: string[], actions?: Array<Record<string, unknown>>): Promise<Array<{ ok: boolean; error?: string }>> {
  const file = path.join(directory, "race-worker.mjs");
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "budget.ts")).href;
  fs.writeFileSync(file, `
    import { reserveSubagentBudgets, overrideResumeBudgets } from ${JSON.stringify(moduleUrl)};
    process.once('message', ({ budget, id, override, reserveBudget }) => {
      try {
        if (override) overrideResumeBudgets(budget, [override]);
        else reserveSubagentBudgets(reserveBudget || budget, id, [{ agent: 'worker', task: 'work', max_agents_allowed: 2 }]);
        process.send({ ok: true });
      } catch (error) { process.send({ ok: false, error: error.message }); }
      process.disconnect();
    });
    process.send({ ready: true });
  `);
  const children = ids.map(() => fork(file, {
    execArgv: ["--import", "tsx/esm"],
    env: { ...process.env, TMPDIR: directory },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  const results = children.map((child, index) => new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    let answer: { ok: boolean; error?: string } | undefined;
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("message", (message: any) => {
      if (message.ready) {
        ready++;
        if (ready === children.length) children.forEach((worker, i) => worker.send({ budget: { directory: path.join(directory, "budget") }, id: ids[i], ...actions?.[i] }));
      } else answer = message;
    });
    child.on("exit", (code) => answer && code === 0 ? resolve(answer) : reject(new Error(`Worker ${index} failed: ${stderr}`)));
  }));
  let ready = 0;
  const timer = setTimeout(() => children.forEach((child) => child.kill("SIGKILL")), 20_000);
  try { return await Promise.all(results); }
  finally {
    clearTimeout(timer);
    children.forEach((child) => { if (child.exitCode === null) child.kill("SIGKILL"); });
  }
}

describe("subagent budgets", () => {
  test("defaults to 50 and accepts only non-negative safe integer configuration", () => {
    const previous = process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS;
    delete process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS;
    try { assert.equal(configuredTotalBudget(), 50); }
    finally {
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
      for (const count of [0, 29, 30, 50, 1000]) {
        const budget = createBudget(path.join(dir, String(count)), count);
        const mainPrompt = budgetPrompt(budget, "main");
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
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
      assert.match(budgetPrompt(child), /You may launch at most 1 more subagent/);
      createBudget(root.directory, 999);
      assert.equal(readBudget(root).limit, 3);
      assert.throws(() => reserveSubagentBudgets(root, "first", [task(1)]), /different budget/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("rejects missing, zero, fractional, negative, and overflowing allowances", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 10);
      for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, "2", Number.MAX_SAFE_INTEGER]) {
        assert.throws(() => reserveSubagentBudgets(root, "bad", [{ ...task(), max_agents_allowed: value as any }]));
      }
      assert.throws(() => reserveSubagentBudgets(root, "overflow", [task(Number.MAX_SAFE_INTEGER), task()]), /too large/);
      assert.equal(readBudget(root).remaining, 10);
      const zero = createBudget(path.join(dir, "zero"), 0);
      assert.throws(() => reserveSubagentBudgets(zero, "new", [task()]), /has 0 slots left/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
      assert.throws(() => findPersistedBudget([{ type: "custom", customType: SUBAGENT_BUDGET_CUSTOM_TYPE, data: {} }]), /Invalid saved/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
      const leaves = reserveSubagentBudgets(child, "nine", Array.from({ length: 9 }, () => task(1)));
      assert.equal(readBudget(child).remaining, 0);
      assert.ok(leaves.every((leaf) => readBudget(leaf).remaining === 0));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("reads old exclusive reservations without charging again or resetting slots", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 5);
      const [child] = reserveSubagentBudgets(root, "old-call", [task(3)]);
      reserveSubagentBudgets(child, "work", [task(1)]);
      const file = path.join(root.directory, "state-1.json");
      const oldState = JSON.parse(fs.readFileSync(file, "utf8"));
      oldState.version = 1;
      for (const reservation of Object.values(oldState.reservations) as any[]) {
        reservation.tasks = reservation.tasks.map((item: BudgetTask) => ({
          agent: item.agent, task: item.task, max_subagents_allowed: item.max_agents_allowed - 1,
        }));
      }
      fs.writeFileSync(file, JSON.stringify(oldState));
      assert.deepEqual(reserveSubagentBudgets(root, "old-call", [task(3)]), [child]);
      assert.equal(readBudget(root).remaining, 2);
      assert.equal(readBudget(child).remaining, 1);
      reserveSubagentBudgets(root, "new-call", [task(2)]);
      assert.equal(readBudget(root).remaining, 0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root.directory, "state-2.json"), "utf8")).version, 4);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("renaming the inclusive argument preserves existing reservations", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 10);
      const [child] = reserveSubagentBudgets(root, "previous-name", [task(4)]);
      reserveSubagentBudgets(child, "used", [task(1)]);
      const file = path.join(root.directory, "state-1.json");
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      saved.version = 2;
      for (const reservation of Object.values(saved.reservations) as any[]) {
        reservation.tasks = reservation.tasks.map((item: BudgetTask) => ({
          agent: item.agent, task: item.task, max_agents_in_branch: item.max_agents_allowed,
        }));
      }
      fs.writeFileSync(file, JSON.stringify(saved));
      assert.deepEqual(reserveSubagentBudgets(root, "previous-name", [task(4)]), [child]);
      assert.equal(readBudget(root).remaining, 6);
      assert.equal(readBudget(child).remaining, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

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
      assert.throws(() => overrideResumeBudgets(root, [{ budget: child, max_agents_allowed: 1 }]), /already needs 2 slots/);
      assert.equal(readBudget(child).remaining, 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("rejects unaffordable batches, unrelated overrides, and shrinking assigned slots", () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "root"), 5);
      const [a, b] = reserveSubagentBudgets(root, "first", [task(2), task(2)]);
      assert.throws(() => overrideResumeBudgets(root, [
        { budget: a, max_agents_allowed: 3 }, { budget: b, max_agents_allowed: 3 },
      ]), /needs 2 extra slots/);
      assert.equal(readBudget(root).remaining, 1);
      assert.equal(readBudget(a).limit, 1);
      assert.equal(readBudget(b).limit, 1);
      assert.throws(() => overrideResumeBudgets(a, [{ budget: b, max_agents_allowed: 3 }]), /outside your own delegation tree/);
      reserveSubagentBudgets(a, "used", [task(1)]);
      assert.throws(() => overrideResumeBudgets(root, [{ budget: a, max_agents_allowed: 1 }]), /already needs 2 slots/);
      for (const invalid of [0, -1, 1.5, NaN]) {
        assert.throws(() => overrideResumeBudgets(root, [{ budget: b, max_agents_allowed: invalid }]), /positive safe integer/);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
      assert.throws(() => overrideResumeBudgets(root, [
        { budget: parent, max_agents_allowed: 7 }, { budget: child, max_agents_allowed: 5 },
      ]), /same original launcher/);
      assert.equal(readBudget(root).remaining, 4);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("concurrent resume increases reserve extra capacity only once", { timeout: 30_000 }, async () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "budget"), 4);
      const [child] = reserveSubagentBudgets(root, "first", [task(1)]);
      const ids = Array.from({ length: 6 }, (_, index) => `resize-${index}`);
      const results = await race(dir, ids, ids.map(() => ({ override: { budget: child, max_agents_allowed: 4 } })));
      assert.ok(results.every((result) => result.ok));
      assert.equal(readBudget(root).remaining, 0);
      assert.equal(readBudget(child).remaining, 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("a concurrent launch and conflicting decrease cannot both succeed", { timeout: 30_000 }, async () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "budget"), 5);
      const [child] = reserveSubagentBudgets(root, "first", [task(3)]);
      const results = await race(dir, ["decrease", "launch"], [
        { override: { budget: child, max_agents_allowed: 1 } }, { reserveBudget: child },
      ]);
      assert.equal(results.filter((result) => result.ok).length, 1);
      assert.equal(readBudget(child).remaining, 0);
      assert.equal(readBudget(root).remaining, 2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("parallel processes cannot reserve the same remaining slots", { timeout: 30_000 }, async () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "budget"), 8);
      const results = await race(dir, Array.from({ length: 8 }, (_, i) => `call-${i}`));
      assert.equal(results.filter((result) => result.ok).length, 4);
      assert.equal(readBudget(root).remaining, 0);
      for (const result of results.filter((result) => !result.ok)) assert.match(result.error!, /budget exceeded/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test("parallel retries of one call share one reservation", { timeout: 30_000 }, async () => {
    const dir = workspace();
    try {
      const root = createBudget(path.join(dir, "budget"), 2);
      const results = await race(dir, Array.from({ length: 6 }, () => "same-call"));
      assert.ok(results.every((result) => result.ok));
      assert.equal(readBudget(root).remaining, 0);
      assert.equal(fs.readdirSync(path.join(root.directory, "children")).length, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
