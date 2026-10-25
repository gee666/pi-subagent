import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import {
  budgetPrompt,
  clearSessionBudgetLimit,
  createBudget,
  overrideResumeBudgets,
  readBudget,
  reserveSubagentBudgets,
  setSessionBudgetLimit,
  SubagentBudgetError,
  type SubagentBudget,
} from "../budget.js";
import { latestState } from "../storage/budget-ledger.js";
import { task, workspace } from "./fixtures/budget.js";

function fixture(t: TestContext, limit: number) {
  const directory = workspace();
  const root = createBudget(path.join(directory, "root"), limit);
  t.after(() => {
    clearSessionBudgetLimit(root);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return root;
}

function ledger(budget: SubagentBudget) {
  const { state } = latestState(budget);
  const allocated = Object.values(state.reservations).reduce(
    (sum, reservation) =>
      sum +
      reservation.tasks.reduce(
        (total, task, index) => total + (reservation.reservedSizes?.[index] ?? task.max_subagents_allowed + 1),
        0,
      ),
    0,
  );
  assert.equal(state.limit - allocated, state.remaining);
  assert.ok(state.remaining >= 0);
  return state;
}

function freshProcess(root: SubagentBudget, body: string): unknown {
  const moduleUrl = pathToFileURL(path.resolve("budget.ts")).href;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "--input-type=module",
        "--eval",
        `
    import * as api from ${JSON.stringify(moduleUrl)};
    const root = ${JSON.stringify(root)};
    const task = (n = 0) => ({agent: "worker", task: "work", max_subagents_allowed: n});
    ${body}
  `,
      ],
      { encoding: "utf8", timeout: 15_000, env: { ...process.env, TMPDIR: path.dirname(root.directory) } },
    ),
  );
}

test("setting and clearing a live cap never writes a default or ledger revision", (t) => {
  const root = fixture(t, 5);
  const before = latestState(root);
  setSessionBudgetLimit(root, 10);
  assert.deepEqual(readBudget(root), { limit: 10, remaining: 10 });
  assert.match(budgetPrompt(root, "main"), /at most 10 more/);
  assert.deepEqual(latestState(root), before);
  assert.deepEqual(readBudget(createBudget(root.directory, 999)), { limit: 10, remaining: 10 });
  assert.deepEqual(freshProcess(root, "console.log(JSON.stringify(api.readBudget(root)));"), {
    limit: 5,
    remaining: 5,
  });
  setSessionBudgetLimit(root, 0);
  assert.equal(budgetPrompt(root), "You cannot launch subagents.");
  assert.throws(() => reserveSubagentBudgets(root, "blocked", [task()]), /has 0 slots left/);
  clearSessionBudgetLimit(root);
  clearSessionBudgetLimit(root);
  assert.deepEqual(readBudget(root), { limit: 5, remaining: 5 });
  assert.deepEqual(latestState(root), before);
  assert.equal(ledger(root).baselineLimit, undefined);
});

test("lower caps account for reservations, reject partial batches, and never refund", (t) => {
  const root = fixture(t, 10);
  const [child] = reserveSubagentBudgets(root, "original", [task(3)]);
  reserveSubagentBudgets(child, "work", [task()]);
  setSessionBudgetLimit(root, 5);
  const before = latestState(root);
  assert.deepEqual(readBudget(root), { limit: 5, remaining: 1 });
  assert.equal(budgetPrompt(root), "You may launch one subagent and resume it as often as needed.");
  assert.throws(() => reserveSubagentBudgets(root, "batch", [task(), task()]), /needs 2 slots.*has 1 slots left/);
  assert.deepEqual(latestState(root), before);
  assert.deepEqual(reserveSubagentBudgets(root, "original", [task(3)]), [child]);
  reserveSubagentBudgets(root, "last", [task()]);
  assert.equal(readBudget(root).remaining, 0);
  assert.throws(() => setSessionBudgetLimit(root, 4), /5 slots are already spent or reserved/);
  assert.deepEqual(readBudget(root), { limit: 5, remaining: 0 });
  setSessionBudgetLimit(root, 5);
  clearSessionBudgetLimit(root);
  assert.deepEqual(readBudget(root), { limit: 10, remaining: 5 });
  assert.deepEqual(readBudget(child), { limit: 3, remaining: 2 });
  assert.equal(ledger(root).baselineLimit, undefined);
});

test("spending above the baseline survives clear and resume without minting slots", (t) => {
  const root = fixture(t, 5);
  const [child] = reserveSubagentBudgets(root, "original", [task(2)]);
  setSessionBudgetLimit(root, 8);
  const [funded] = reserveSubagentBudgets(root, "extra", [task(3)]);
  assert.deepEqual(readBudget(root), { limit: 8, remaining: 1 });
  assert.deepEqual({ limit: ledger(root).limit, baseline: ledger(root).baselineLimit }, { limit: 7, baseline: 5 });
  const before = latestState(root);
  clearSessionBudgetLimit(root);
  assert.deepEqual(readBudget(root), { limit: 5, remaining: 0 });
  assert.deepEqual(latestState(root), before);
  assert.equal(budgetPrompt(root, "main"), "You cannot launch subagents.");
  assert.throws(() => reserveSubagentBudgets(root, "denied", [task()]), /has 0 slots left/);
  assert.deepEqual(reserveSubagentBudgets(root, "extra", [task(3)]), [funded]);
  assert.deepEqual(reserveSubagentBudgets(root, "original", [task(2)]), [child]);
  assert.throws(() => reserveSubagentBudgets(root, "extra", [task()]), /already reserved a different budget/);
  assert.throws(() => setSessionBudgetLimit(root, 6), /7 slots are already spent or reserved/);
  assert.deepEqual(readBudget(createBudget(root.directory, 1000)), { limit: 5, remaining: 0 });
  assert.deepEqual(
    freshProcess(
      root,
      `
    api.createBudget(root.directory, 1000);
    let blocked = false;
    try { api.reserveSubagentBudgets(root, "after-reload", [task()]); } catch (e) { blocked = /has 0 slots left/.test(e.message); }
    console.log(JSON.stringify({budget: api.readBudget(root), blocked}));
  `,
    ),
    { budget: { limit: 5, remaining: 0 }, blocked: true },
  );
  // A new live increase counts all previous reservations, not the clamped read balance.
  setSessionBudgetLimit(root, 9);
  assert.deepEqual(readBudget(root), { limit: 9, remaining: 2 });
  reserveSubagentBudgets(root, "new-increase", [task(1)]);
  assert.equal(ledger(root).baselineLimit, 5, "a second expansion must not replace the original baseline");
  clearSessionBudgetLimit(root);
  assert.deepEqual(readBudget(root), { limit: 5, remaining: 0 });
  reserveSubagentBudgets(funded, "use-funded-capacity", [task(2)]);
  assert.equal(readBudget(funded).remaining, 0, "clear does not revoke a funded child grant");
  ledger(root);
});

test("root-funded resume increases use the live limit and retain their high-water reservations", (t) => {
  const root = fixture(t, 3);
  const [child] = reserveSubagentBudgets(root, "original", [task()]);
  setSessionBudgetLimit(root, 6);
  overrideResumeBudgets(root, [{ budget: child, max_subagents_allowed: 4 }]);
  assert.deepEqual(readBudget(root), { limit: 6, remaining: 1 });
  assert.deepEqual(readBudget(child), { limit: 4, remaining: 4 });
  assert.equal(ledger(root).baselineLimit, 3);
  assert.equal(ledger(root).limit, 5);
  clearSessionBudgetLimit(root);
  assert.deepEqual(readBudget(root), { limit: 3, remaining: 0 });
  overrideResumeBudgets(root, [{ budget: child, max_subagents_allowed: 1 }]);
  overrideResumeBudgets(root, [{ budget: child, max_subagents_allowed: 4 }]);
  assert.deepEqual(readBudget(root), { limit: 3, remaining: 0 });
  assert.throws(
    () => overrideResumeBudgets(root, [{ budget: child, max_subagents_allowed: 5 }]),
    /needs 1 extra slots.*has 0 unassigned slots/,
  );
  assert.deepEqual(readBudget(child), { limit: 4, remaining: 4 });
  assert.deepEqual(
    freshProcess(
      root,
      `
    const child = ${JSON.stringify(child)};
    let blocked = false;
    try { api.overrideResumeBudgets(root, [{budget: child, max_subagents_allowed: 5}]); }
    catch (e) { blocked = /has 0 unassigned slots/.test(e.message); }
    console.log(JSON.stringify({budget: api.readBudget(root), child: api.readBudget(child), blocked}));
  `,
    ),
    { budget: { limit: 3, remaining: 0 }, child: { limit: 4, remaining: 4 }, blocked: true },
  );
  assert.deepEqual(reserveSubagentBudgets(root, "original", [task()]), [child]);
  reserveSubagentBudgets(child, "descendants", [task(3)]);
  assert.throws(
    () => overrideResumeBudgets(root, [{ budget: child, max_subagents_allowed: 3 }]),
    /already needs 4 descendant slots/,
  );
  ledger(root);
  ledger(child);
});

test("lower root overrides also constrain resume funding, including whole batches", (t) => {
  const root = fixture(t, 10);
  const [a, b] = reserveSubagentBudgets(root, "original", [task(), task()]);
  setSessionBudgetLimit(root, 3);
  const before = latestState(root);
  assert.throws(
    () =>
      overrideResumeBudgets(root, [
        { budget: a, max_subagents_allowed: 1 },
        { budget: b, max_subagents_allowed: 1 },
      ]),
    /needs 2 extra slots.*has 1 unassigned slots/,
  );
  assert.deepEqual(latestState(root), before);
  assert.equal(readBudget(a).limit, 0);
  assert.equal(readBudget(b).limit, 0);
  overrideResumeBudgets(root, [{ budget: a, max_subagents_allowed: 1 }]);
  assert.equal(readBudget(root).remaining, 0);
  clearSessionBudgetLimit(root);
  assert.deepEqual(readBudget(root), { limit: 10, remaining: 7 });
  assert.equal(ledger(root).baselineLimit, undefined);
});

test("children cannot use the session API to bypass their parent grant", (t) => {
  const root = fixture(t, 20);
  const [parent] = reserveSubagentBudgets(root, "parent", [task(2)]);
  const [child] = reserveSubagentBudgets(parent, "child", [task()]);
  for (const budget of [parent, child]) {
    assert.throws(() => setSessionBudgetLimit(budget, 100), /only to roots.*parent funding/);
  }
  setSessionBudgetLimit(root, 100);
  assert.throws(
    () => overrideResumeBudgets(root, [{ budget: child, max_subagents_allowed: 2 }]),
    /needs 2 extra slots.*has 1 unassigned slots/,
  );
  assert.deepEqual(readBudget(parent), { limit: 2, remaining: 1 });
  assert.deepEqual(readBudget(child), { limit: 0, remaining: 0 });
  assert.equal(ledger(parent).baselineLimit, undefined);
});

test("limits are validated without replacing a previous override; aliases share one cap", (t) => {
  const root = fixture(t, 5);
  setSessionBudgetLimit(root, 8);
  for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3", undefined, null]) {
    assert.throws(() => setSessionBudgetLimit(root, invalid as number), SubagentBudgetError);
    assert.deepEqual(readBudget(root), { limit: 8, remaining: 8 });
  }
  const alias = { directory: path.relative(process.cwd(), root.directory) + path.sep + "." };
  assert.deepEqual(readBudget(alias), { limit: 8, remaining: 8 });
  setSessionBudgetLimit(alias, Number.MAX_SAFE_INTEGER);
  reserveSubagentBudgets(root, "max", [task(Number.MAX_SAFE_INTEGER - 1)]);
  assert.equal(readBudget(root).remaining, 0);
  assert.equal(ledger(root).limit, Number.MAX_SAFE_INTEGER);
  assert.equal(ledger(root).baselineLimit, 5);
  clearSessionBudgetLimit(alias);
  assert.deepEqual(readBudget(root), { limit: 5, remaining: 0 });
});

test("overrides are isolated by directory and missing or corrupt ledgers fail closed", (t) => {
  const root = fixture(t, 5);
  const other = fixture(t, 2);
  setSessionBudgetLimit(root, 10);
  assert.deepEqual(readBudget(other), { limit: 2, remaining: 2 });
  const missing = { directory: path.join(root.directory, "missing") };
  assert.throws(() => setSessionBudgetLimit(missing, 10), /Cannot read subagent budget/);
  fs.writeFileSync(path.join(root.directory, "state-1.json"), "broken");
  assert.throws(() => setSessionBudgetLimit(root, 100), /allowance will not be reset/);
  assert.throws(() => reserveSubagentBudgets(root, "denied", [task()]), /allowance will not be reset/);
  clearSessionBudgetLimit(root);
  assert.throws(() => readBudget(root), /Cannot read subagent budget/);
});

test("reloading the budget module drops its override but retains lifetime spending", async (t) => {
  const root = fixture(t, 2);
  setSessionBudgetLimit(root, 5);
  reserveSubagentBudgets(root, "extra", [task(2)]);
  const reloaded = (await import(
    pathToFileURL(path.resolve("budget.ts")).href + "?session-limit-reload"
  )) as typeof import("../budget.js");
  assert.deepEqual(reloaded.readBudget(root), { limit: 2, remaining: 0 });
  assert.deepEqual(readBudget(root), { limit: 5, remaining: 2 });
  assert.throws(() => reloaded.reserveSubagentBudgets(root, "denied", [task()]), /has 0 slots left/);
  assert.throws(() => reloaded.setSessionBudgetLimit(root, 2), /3 slots are already spent or reserved/);
  reloaded.clearSessionBudgetLimit(root);
  ledger(root);
});

test("competing session overrides preserve the baseline and cannot double-spend", { timeout: 90_000 }, async (t) => {
  const root = fixture(t, 2);
  const moduleUrl = pathToFileURL(path.resolve("budget.ts")).href;
  const results = await Promise.all(
    Array.from({ length: 6 }, async (_, index) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx/esm",
          "--input-type=module",
          "--eval",
          `
      import * as api from ${JSON.stringify(moduleUrl)};
      const root = ${JSON.stringify(root)};
      api.setSessionBudgetLimit(root, 6);
      let ok = false;
      try {
        api.reserveSubagentBudgets(root, ${JSON.stringify(`race-${index}`)}, [{agent: "worker", task: "work", max_subagents_allowed: 2}]);
        ok = true;
      } catch (e) { if (!/budget exceeded/.test(e.message)) throw e; }
      console.log(JSON.stringify(ok));
    `,
        ],
        { timeout: 60_000, env: { ...process.env, TMPDIR: path.dirname(root.directory) } },
      );
      return JSON.parse(stdout) as boolean;
    }),
  );
  assert.equal(results.filter(Boolean).length, 2);
  assert.deepEqual(readBudget(root), { limit: 2, remaining: 0 });
  const state = ledger(root);
  assert.equal(state.limit, 6);
  assert.equal(state.remaining, 0);
  assert.equal(state.baselineLimit, 2);
  assert.equal(Object.keys(state.reservations).length, 2);
});

test("malformed baseline metadata fails closed instead of restoring accounting capacity", (t) => {
  const root = fixture(t, 5);
  for (const invalid of [-1, 1.5, "5", null, 6, Number.MAX_SAFE_INTEGER + 1]) {
    fs.writeFileSync(
      path.join(root.directory, "state-1.json"),
      JSON.stringify({
        ...latestState({ directory: root.directory }).state,
        baselineLimit: invalid,
      }),
    );
    assert.throws(() => readBudget(root), /invalid budget state/);
    assert.throws(() => setSessionBudgetLimit(root, 10), /invalid budget state/);
    fs.unlinkSync(path.join(root.directory, "state-1.json"));
  }
});
