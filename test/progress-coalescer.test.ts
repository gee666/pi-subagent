import assert from "node:assert/strict";
import { test } from "node:test";
import { ProgressCoalescer } from "../runner/progress-coalescer.js";

test("initial progress is immediate and a burst builds one latest trailing snapshot", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const current = [0, 0];
  const snapshots: number[][] = [];
  const progress = new ProgressCoalescer(() => snapshots.push([...current]));
  progress.request();
  assert.deepEqual(snapshots, [[0, 0]]);
  for (let i = 1; i <= 500; i++) {
    current[i % 2] = i;
    progress.request();
  }
  assert.deepEqual(current, [500, 499], "incoming state changes are never delayed");
  t.mock.timers.tick(99);
  assert.equal(snapshots.length, 1, "snapshot work itself must be deferred");
  t.mock.timers.tick(1);
  assert.deepEqual(snapshots, [
    [0, 0],
    [500, 499],
  ]);
  t.mock.timers.tick(1000);
  assert.equal(snapshots.length, 2, "no trailing duplicate without another request");
  progress.dispose();
});

test("sustained progress is batch-wide and limited to 100ms intervals", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const times: number[] = [];
  const progress = new ProgressCoalescer(() => times.push(Date.now()));
  progress.request();
  for (let i = 0; i < 100; i++) {
    for (let sibling = 0; sibling < 8; sibling++) progress.request();
    t.mock.timers.tick(10);
  }
  assert.deepEqual(
    times,
    Array.from({ length: 11 }, (_, i) => i * 100),
  );
  progress.dispose();
});

test("heartbeat requests share the pending child-update interval", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const times: number[] = [];
  const progress = new ProgressCoalescer(() => times.push(Date.now()));
  progress.request();
  t.mock.timers.tick(90);
  progress.request(); // Child update.
  t.mock.timers.tick(5);
  progress.request(); // Heartbeat, not a separate emission path.
  assert.deepEqual(times, [0]);
  t.mock.timers.tick(5);
  assert.deepEqual(times, [0, 100]);
  t.mock.timers.tick(900);
  progress.request();
  assert.deepEqual(times, [0, 100, 1000], "quiet-period requests emit immediately");
  progress.dispose();
});

test("completion flushes the latest pending result immediately and cancels its timer", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let result = "initial";
  const snapshots: string[] = [];
  const progress = new ProgressCoalescer(() => snapshots.push(result));
  progress.request();
  t.mock.timers.tick(25);
  result = "intermediate";
  progress.request();
  result = "final";
  progress.request();
  progress.flush();
  progress.flush();
  assert.deepEqual(snapshots, ["initial", "final"]);
  t.mock.timers.tick(1000);
  assert.equal(snapshots.length, 2);
  progress.dispose();
});

test("dispose drops pending work and ignores late requests and flushes", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let snapshots = 0;
  const progress = new ProgressCoalescer(() => snapshots++);
  progress.request();
  progress.request();
  progress.dispose();
  progress.dispose();
  progress.request();
  progress.flush();
  t.mock.timers.tick(10000);
  assert.equal(snapshots, 1);
});

test("cleanup after a callback failure cancels reentrant pending work", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let snapshots = 0;
  const progress = new ProgressCoalescer(() => {
    snapshots++;
    progress.request();
    throw new Error("callback failed");
  });
  try {
    assert.throws(() => progress.request(), /callback failed/);
  } finally {
    progress.dispose();
  }
  t.mock.timers.tick(1000);
  assert.equal(snapshots, 1);
});
