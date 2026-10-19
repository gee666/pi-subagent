import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getActivitySnapshot } from "../extension/activity.js";
import type { BroadcastTarget } from "../extension/broadcast.js";
import { createExtensionState, type ExtensionState } from "../extension/state.js";
import { hostDouble } from "./helpers/extension.js";

function fixture() {
  return createExtensionState(hostDouble<ExtensionAPI>({ getFlag: () => undefined }));
}

function active(
  name: string,
  startedAt?: number,
): ExtensionState["activeSubagents"] extends Map<number, infer T> ? T : never {
  return { name, agent: "worker", task: "work", startedAt, handle: { steer() {} } };
}

function target(topLevelId: number, path: string[], options: Partial<BroadcastTarget> = {}): BroadcastTarget {
  return { topLevelId, display: path.join(" > "), restPath: path.slice(1), ...options };
}

test("snapshot uses live names, paths, start times and idle status in depth/root/name order", () => {
  const state = fixture();
  state.activeSubagents.set(2, active("Zoe", 200));
  state.activeSubagents.set(1, { ...active("Anna", 100), handle: { steer() {}, isIdle: () => true } });
  state.latestBroadcastTargets.all = [
    target(2, ["Zoe", "Bea"]),
    target(1, ["Anna", "Zed"], { startedAt: 400, idle: true }),
    target(1, ["Anna", "Amy", "Deep"], { startedAt: 500 }),
    target(1, ["Anna", "Amy"], { startedAt: 300 }),
    target(1, ["Old root name"], { startedAt: 999, idle: false }),
    target(99, ["Finished", "Stale"]),
  ];
  assert.deepEqual(getActivitySnapshot(state, 1000), [
    { name: "Anna", path: ["Anna"], depth: 0, topLevelId: 1, startedAt: 100, status: "idle" },
    { name: "Zoe", path: ["Zoe"], depth: 0, topLevelId: 2, startedAt: 200, status: "running" },
    { name: "Amy", path: ["Anna", "Amy"], depth: 1, topLevelId: 1, startedAt: 300, status: "running" },
    { name: "Zed", path: ["Anna", "Zed"], depth: 1, topLevelId: 1, startedAt: 400, status: "idle" },
    { name: "Bea", path: ["Zoe", "Bea"], depth: 1, topLevelId: 2, startedAt: 1000, status: "running" },
    { name: "Deep", path: ["Anna", "Amy", "Deep"], depth: 2, topLevelId: 1, startedAt: 500, status: "running" },
  ]);
});

test("handle idle state takes precedence, with target and agent-name fallbacks", () => {
  const state = fixture();
  state.activeSubagents.set(1, { ...active(""), agent: "reviewer", handle: { steer() {}, isIdle: () => false } });
  state.activeSubagents.set(2, active("Bea"));
  state.activeSubagents.set(3, { ...active(""), agent: "" });
  state.latestBroadcastTargets.all = [
    target(1, ["Old"], { startedAt: 100, idle: true }),
    target(2, ["Bea"], { startedAt: 200, idle: true }),
  ];
  assert.deepEqual(
    getActivitySnapshot(state, 1000).map(({ name, status, startedAt }) => ({ name, status, startedAt })),
    [
      { name: "reviewer", status: "running", startedAt: 100 },
      { name: "Bea", status: "idle", startedAt: 200 },
      { name: "worker", status: "running", startedAt: 1000 },
    ],
  );
});

test("missing timestamps stay stable only while the same names remain live", () => {
  const state = fixture();
  state.activeSubagents.set(1, active("Anna"));
  state.latestBroadcastTargets.all = [target(1, ["Anna", "Bea"])];
  assert.deepEqual(
    getActivitySnapshot(state, 1000).map((entry) => entry.startedAt),
    [1000, 1000],
  );
  assert.deepEqual(
    getActivitySnapshot(state, 2000).map((entry) => entry.startedAt),
    [1000, 1000],
  );
  state.latestBroadcastTargets.all = [];
  assert.deepEqual(
    getActivitySnapshot(state, 3000).map((entry) => entry.name),
    ["Anna"],
  );
  state.latestBroadcastTargets.all = [target(1, ["Anna", "Bea"])];
  assert.deepEqual(
    getActivitySnapshot(state, 4000).map((entry) => entry.startedAt),
    [1000, 4000],
  );
  state.activeSubagents.clear();
  assert.deepEqual(getActivitySnapshot(state, 4001), [], "stale broadcast targets cannot keep a finished tree alive");
  state.activeSubagents.set(1, active("Anna"));
  assert.deepEqual(
    getActivitySnapshot(state, 5000).map((entry) => entry.startedAt),
    [5000, 5000],
  );
});

test("generation changes discard cached names and first-seen timestamps immediately", () => {
  const state = fixture();
  state.activeSubagents.set(1, active("Anna"));
  getActivitySnapshot(state, 1000);
  state.lifecycleGeneration++;
  state.activeSubagents.set(1, active("Bea"));
  assert.deepEqual(
    getActivitySnapshot(state, 1001).map(({ name, startedAt }) => ({ name, startedAt })),
    [{ name: "Bea", startedAt: 1001 }],
  );
  state.lifecycleGeneration++;
  assert.equal(getActivitySnapshot(state, 1002)[0].startedAt, 1002);
});
