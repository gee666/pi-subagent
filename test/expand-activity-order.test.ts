import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityEntry } from "../extension/activity.js";
import { buildExpandPickerItems } from "../extension/expand-command.js";
import { emptyNamesRegistry, type SubagentNameRecord } from "../names.js";

function record(name: string, createdAt: number): SubagentNameRecord {
  return { name, createdAt, agent: "worker", task: "work", ownerSessionId: "owner", sessionDir: "", forks: {} };
}

function activity(name: string, depth: number, status: ActivityEntry["status"], topLevelId = 1): ActivityEntry {
  return { name, depth, status, topLevelId, path: [name], startedAt: 100 };
}

test("expand orders running by level, idle by level, then newest history", () => {
  const registry = emptyNamesRegistry();
  const records = [
    record("Recent", 900),
    record("IdleChild", 800),
    record("RunningChild", 700),
    record("IdleRoot", 600),
    record("RunningRoot", 500),
    record("Old", 1),
  ];
  for (const item of records) registry.agents[item.name] = item;
  // The activity snapshot has already ordered each level by top-level id and path.
  const snapshot = [
    activity("IdleRoot", 0, "idle"),
    activity("RunningRoot", 0, "running", 2),
    activity("RunningChild", 1, "running"),
    activity("IdleChild", 1, "idle", 2),
  ];
  const items = buildExpandPickerItems(registry, snapshot);
  assert.deepEqual(
    items.map(({ name }) => name),
    ["RunningRoot", "RunningChild", "IdleRoot", "IdleChild", "Recent", "Old"],
  );
  assert.deepEqual(
    items.map(({ status, depth }) => [status, depth]),
    [
      ["running", 0],
      ["running", 1],
      ["idle", 0],
      ["idle", 1],
      [undefined, undefined],
      [undefined, undefined],
    ],
  );
  assert.deepEqual(Object.values(registry.agents), records, "sorting must not mutate registry order");
});

test("expand retains snapshot tie order instead of age and matches live names case-insensitively", () => {
  const registry = emptyNamesRegistry();
  for (const item of [record("Zoe", 1), record("Ada", 900), record("Maria", 800), record("Olga", 700)]) {
    registry.agents[item.name] = item;
  }
  const snapshot = [
    activity("zoe", 0, "running", 1),
    activity("Ada", 0, "running", 2),
    activity("Maria", 0, "idle", 3),
    activity("Olga", 0, "idle", 4),
    activity("Unregistered", 1, "running"),
  ];
  assert.deepEqual(
    buildExpandPickerItems(registry, snapshot).map(({ name }) => name),
    ["Zoe", "Ada", "Maria", "Olga"],
  );
  assert.deepEqual(
    buildExpandPickerItems(registry, []).map(({ name }) => name),
    ["Ada", "Maria", "Olga", "Zoe"],
  );
  assert.ok(
    buildExpandPickerItems(registry, []).every((item) => item.status === undefined && item.depth === undefined),
  );
});
