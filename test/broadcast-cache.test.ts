import assert from "node:assert/strict";
import { test } from "node:test";
import { getActivitySnapshot } from "../extension/activity.js";
import { updateLatestBroadcastTargets, type BroadcastTarget } from "../extension/broadcast.js";
import type { ExtensionState } from "../extension/state.js";
import { buildLiveSubagentDetails, type SingleResult } from "../types.js";
import { hostDouble } from "./helpers/extension.js";
import { makeRunningResult } from "./helpers/results.js";

type Active = NonNullable<ReturnType<ExtensionState["activeSubagents"]["get"]>>;
class CountedMap extends Map<number, Active> {
  gets = 0;
  visits = 0;
  get(id: number) {
    this.gets++;
    return super.get(id);
  }
  *entries(): MapIterator<[number, Active]> {
    for (const entry of super.entries()) {
      this.visits++;
      yield entry;
    }
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  *values(): MapIterator<Active> {
    for (const [, value] of this.entries()) yield value;
  }
  *keys(): MapIterator<number> {
    for (const [id] of this.entries()) yield id;
  }
  forEach(callback: (value: Active, id: number, map: Map<number, Active>) => void, thisArg?: unknown) {
    for (const [id, value] of this.entries()) callback.call(thisArg, value, id, this);
  }
  reset() {
    this.gets = 0;
    this.visits = 0;
  }
}

const details = (...results: SingleResult[]) => buildLiveSubagentDetails("parallel", "spawn", null, results);
const running = (name: string, child?: string, extra: Partial<SingleResult> = {}) =>
  makeRunningResult({
    name,
    startedAt: 10,
    ...(child
      ? { liveNestedSubagents: { children: details(makeRunningResult({ name: child, startedAt: 20, idle: true })) } }
      : {}),
    ...extra,
  });

function fixture(count = 2) {
  const active = new CountedMap();
  for (let id = 1; id <= count; id++)
    active.set(id, {
      agent: "worker",
      name: `Root${id}`,
      task: "work",
      startedAt: 1,
      handle: { steer() {} },
    });
  const state = hostDouble<ExtensionState>({
    activeSubagents: active,
    lifecycleGeneration: 0,
    latestBroadcastTargets: { all: [], youngest: [] },
    onActivityChanged: undefined,
  });
  const snapshot = (id: number, child = `Leaf${id}`) =>
    updateLatestBroadcastTargets(state, details(running(`Root${id}`, child)), id);
  return { state, active, snapshot };
}
const names = (targets: BroadcastTarget[]) => targets.map(({ display }) => display);

test("1000 independent jobs update only their own root and sort only when arrays are read", (t) => {
  const f = fixture(1000);
  let comparisons = 0;
  const compare = String.prototype.localeCompare;
  t.mock.method(String.prototype, "localeCompare", function (this: string, other: string) {
    comparisons++;
    return compare.call(this, other);
  });
  for (let id = 1; id <= 1000; id++) f.snapshot(id);
  assert.equal(f.active.gets, 1000, "one active-handle lookup per reported root");
  assert.equal(f.active.visits, 0, "progress must not iterate all active jobs");
  assert.equal(comparisons, 0, "progress must not flatten or sort global target arrays");
  const first = f.state.latestBroadcastTargets.all;
  assert.equal(first.length, 2000);
  assert.equal(f.state.latestBroadcastTargets.youngest.length, 1000);
  assert.ok(comparisons > 0);
  const sorted = comparisons;
  assert.equal(f.state.latestBroadcastTargets.all, first, "unchanged reads reuse the array snapshot");
  assert.equal(comparisons, sorted, "unchanged reads must not re-sort");

  const update = details(running("Root500", "Replacement", { idle: true, startedAt: 99 }));
  f.active.reset();
  comparisons = 0;
  for (let i = 0; i < 1000; i++) updateLatestBroadcastTargets(f.state, update, 500);
  assert.equal(f.active.gets, 1000);
  assert.equal(f.active.visits, 0);
  assert.equal(comparisons, 0);
  const latest = f.state.latestBroadcastTargets.all;
  assert.notEqual(latest, first);
  assert.equal(latest.length, 2000);
  assert.equal(latest.find(({ display }) => display === "Root500")?.startedAt, 99);
  assert.ok(names(latest).includes("Root500 > Replacement"));
  assert.ok(!names(latest).includes("Root500 > Leaf500"));
  assert.ok(names(latest).includes("Root499 > Leaf499"));
  t.diagnostic("1000-job updates: 1 handle lookup/update, 0 active-map visits/update, 0 sort comparisons/update");
});

test("fallback discovery is one lazy root pass, not a growing scan on every handle change", () => {
  const f = fixture(1000);
  for (let i = 0; i < 1000; i++) updateLatestBroadcastTargets(f.state, undefined);
  assert.equal(f.active.gets, 0);
  assert.equal(f.active.visits, 0);
  assert.equal(f.state.latestBroadcastTargets.all.length, 1000);
  assert.equal(f.active.visits, 1000);
  assert.equal(f.active.gets, 0);
  f.active.reset();
  assert.equal(f.state.latestBroadcastTargets.youngest.length, 1000);
  assert.equal(f.active.visits, 1000);
  assert.equal(f.active.gets, 0);
});

test("completed roots and descendants are pruned on direct reads, including after an unrelated update", () => {
  const f = fixture();
  f.snapshot(1);
  f.snapshot(2);
  assert.equal(f.state.latestBroadcastTargets.all.length, 4);
  f.active.delete(1);
  f.snapshot(2, "NewLeaf");
  assert.deepEqual(names(f.state.latestBroadcastTargets.all), ["Root2", "Root2 > NewLeaf"]);
  f.active.clear();
  assert.deepEqual(f.state.latestBroadcastTargets.all, []);
  assert.deepEqual(f.state.latestBroadcastTargets.youngest, []);
});

test("a final root snapshot clears its placeholders even before the handle is released", () => {
  const f = fixture(1);
  f.snapshot(1);
  updateLatestBroadcastTargets(f.state, details(running("Root1", undefined, { exitCode: 0 })), 1);
  assert.deepEqual(f.state.latestBroadcastTargets.all, []);
  assert.deepEqual(f.state.latestBroadcastTargets.youngest, []);
});

test("same-count replacements and in-place handle replacements cannot inherit old descendants", () => {
  const f = fixture();
  f.snapshot(1);
  f.snapshot(2);
  const before = f.state.latestBroadcastTargets.all;
  const replacement = { agent: "worker", name: "Replacement", task: "work", handle: { steer() {} } };
  f.active.set(1, replacement);
  assert.equal(f.active.size, 2);
  assert.notEqual(f.state.latestBroadcastTargets.all, before);
  assert.deepEqual(names(f.state.latestBroadcastTargets.all), ["Replacement", "Root2", "Root2 > Leaf2"]);
  f.snapshot(1);
  replacement.handle = { steer() {} };
  assert.deepEqual(names(f.state.latestBroadcastTargets.all), ["Replacement", "Root2", "Root2 > Leaf2"]);
  f.active.delete(2);
  f.active.set(3, { ...replacement, name: "Third" });
  assert.deepEqual(names(f.state.latestBroadcastTargets.all), ["Replacement", "Third"]);
});

test("replacing the active map itself validates identities even when its size is unchanged", () => {
  const f = fixture(1);
  f.snapshot(1);
  f.state.activeSubagents = new Map([[1, { agent: "worker", task: "new", name: "New", handle: { steer() {} } }]]);
  assert.deepEqual(names(f.state.latestBroadcastTargets.all), ["New"]);
});

test("session generations discard nested cache entries on reads and on updates", () => {
  const f = fixture(1);
  f.snapshot(1);
  f.state.lifecycleGeneration++;
  f.active.clear();
  f.active.set(1, { agent: "worker", name: "New", task: "new", handle: { steer() {} } });
  assert.deepEqual(names(f.state.latestBroadcastTargets.all), ["New"]);
  updateLatestBroadcastTargets(f.state, details(running("New", "Fresh")), 1);
  f.state.lifecycleGeneration++;
  updateLatestBroadcastTargets(f.state, details(running("New", "Newest")), 1);
  assert.deepEqual(names(f.state.latestBroadcastTargets.all), ["New", "New > Newest"]);
});

test("lifecycle list resets and whole-object replacement do not revive cached descendants", () => {
  const f = fixture(1);
  f.snapshot(1);
  const source = f.state.latestBroadcastTargets;
  source.all = [];
  source.youngest = [];
  assert.deepEqual(source.all, []);
  assert.deepEqual(source.youngest, []);
  f.snapshot(1);
  f.active.clear();
  source.all = [];
  source.youngest = [];
  assert.deepEqual(source, { all: [], youngest: [] });
  f.active.set(1, { agent: "worker", name: "New", task: "new", handle: { steer() {} } });
  f.state.latestBroadcastTargets = { all: [], youngest: [] };
  updateLatestBroadcastTargets(f.state, undefined);
  assert.deepEqual(names(f.state.latestBroadcastTargets.all), ["New"]);
  assert.deepEqual(Object.keys(f.state.latestBroadcastTargets), ["all", "youngest"]);
  assert.ok(Array.isArray(f.state.latestBroadcastTargets.all));
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.latestBroadcastTargets)), {
    all: [{ display: "New", topLevelId: 1, restPath: [] }],
    youngest: [{ display: "New", topLevelId: 1, restPath: [] }],
  });
});

test("external object and list assignments import the assigned arrays, not the old cache", () => {
  const f = fixture(1);
  f.snapshot(1);
  const manual = { display: "Root1 > Manual", topLevelId: 1, restPath: ["Manual"], startedAt: 42, idle: true };
  f.state.latestBroadcastTargets = { all: [manual], youngest: [manual] };
  updateLatestBroadcastTargets(f.state, undefined);
  assert.deepEqual(f.state.latestBroadcastTargets.all, [manual]);
  assert.deepEqual(f.state.latestBroadcastTargets.youngest, [manual]);
  const other = { ...manual, display: "Root1 > Other", restPath: ["Other"] };
  f.state.latestBroadcastTargets.all = [other];
  f.state.latestBroadcastTargets.youngest = [other];
  updateLatestBroadcastTargets(f.state, undefined);
  assert.deepEqual(f.state.latestBroadcastTargets.all, [other]);
  assert.deepEqual(f.state.latestBroadcastTargets.youngest, [other]);
});

test("direct activity consumers see fresh metadata and same-count handle replacements", () => {
  const f = fixture(1);
  f.snapshot(1);
  const entries = getActivitySnapshot(f.state, 100);
  assert.deepEqual(
    entries.map(({ name, startedAt, status }) => ({ name, startedAt, status })),
    [
      { name: "Root1", startedAt: 1, status: "running" },
      { name: "Leaf1", startedAt: 20, status: "idle" },
    ],
  );
  f.active.set(1, {
    agent: "worker",
    name: "New",
    task: "new",
    startedAt: 90,
    handle: { steer() {}, isIdle: () => true },
  });
  assert.deepEqual(
    getActivitySnapshot(f.state, 101).map(({ name, status }) => ({ name, status })),
    [{ name: "New", status: "idle" }],
  );
});

test("fallback root metadata can change without a progress snapshot", () => {
  const f = fixture(1);
  let idle = false;
  f.active.get(1)!.handle.isIdle = () => idle;
  updateLatestBroadcastTargets(f.state, undefined);
  const before = f.state.latestBroadcastTargets.all;
  idle = true;
  f.active.get(1)!.startedAt = 25;
  assert.deepEqual(f.state.latestBroadcastTargets.all, [
    { display: "Root1", topLevelId: 1, restPath: [], startedAt: 25, idle: true },
  ]);
  assert.notEqual(f.state.latestBroadcastTargets.all, before);
});
