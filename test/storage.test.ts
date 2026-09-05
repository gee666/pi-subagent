import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  allocateSubagentNames,
  findPersistedNamesIdentity,
  readNamesRegistry,
  updateNamesRegistry,
  SUBAGENT_NAMES_CUSTOM_TYPE,
} from "../names.js";
import {
  createBudget,
  findPersistedBudget,
  readBudget,
  reserveSubagentBudgets,
  SUBAGENT_BUDGET_CUSTOM_TYPE,
} from "../budget.js";

let directory: string;
beforeEach(() => {
  const root = path.resolve("tmp");
  fs.mkdirSync(root, { recursive: true });
  directory = fs.mkdtempSync(path.join(root, "storage-test-"));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

test("name transactions release their lock and preserve the file when a callback fails", async () => {
  const file = path.join(directory, "names.json");
  const [name] = await allocateSubagentNames(file, "owner", [
    { agent: "worker", task: "before", sessionDir: directory },
  ]);
  const saved = fs.readFileSync(file, "utf8");
  await assert.rejects(
    updateNamesRegistry(file, (registry) => {
      registry.agents[name].task = "not committed";
      throw new Error("stop");
    }),
    /stop/,
  );
  assert.equal(fs.readFileSync(file, "utf8"), saved);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  await updateNamesRegistry(file, (registry) => {
    registry.agents[name].task = "committed";
  });
  assert.equal(readNamesRegistry(file).agents[name].task, "committed");
});

test("invalid decoded name records use the corruption backup path", () => {
  const file = path.join(directory, "names.json");
  const raw = JSON.stringify({ version: 1, counters: {}, agents: { John: { name: "John" } } });
  fs.writeFileSync(file, raw);
  assert.deepEqual(readNamesRegistry(file).agents, {});
  const backup = fs.readdirSync(directory).find((entry) => entry.startsWith("names.json.corrupt-"));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(directory, backup), "utf8"), raw);
});

test("identity lookup ignores malformed custom entry data", () => {
  assert.equal(
    findPersistedNamesIdentity([null, 3, { type: "custom", customType: SUBAGENT_NAMES_CUSTOM_TYPE, data: [] }]),
    undefined,
  );
  assert.throws(
    () => findPersistedBudget([null, { type: "custom", customType: SUBAGENT_BUDGET_CUSTOM_TYPE, data: [] }]),
    /Invalid saved subagent budget/,
  );
});

test("invalid reservation tasks cannot reset or expand an existing budget", () => {
  const budget = createBudget(path.join(directory, "budget"), 3);
  reserveSubagentBudgets(budget, "call", [{ agent: "worker", task: "work", max_agents_allowed: 2 }]);
  const file = path.join(budget.directory, "state-1.json");
  const state = {
    version: 4,
    limit: 3,
    remaining: 1,
    reservations: { broken: { tasks: [null], children: [{ directory: path.join(directory, "child") }] } },
  };
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => readBudget(budget), /invalid reservation task/);
  assert.throws(() => createBudget(budget.directory, 20), /allowance will not be reset/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), state);
});
