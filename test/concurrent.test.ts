import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mapConcurrent } from "../shared.js";

describe("mapConcurrent", () => {
  test("empty array returns empty array", async () => {
    const result = await mapConcurrent([], 5, async (n) => n);
    assert.deepEqual(result, []);
  });

  test("maps items and preserves order", async () => {
    const result = await mapConcurrent([1, 2, 3], 10, async (n) => n * 2);
    assert.deepEqual(result, [2, 4, 6]);
  });

  test("respects concurrency limit of 2", async () => {
    let running = 0;
    let maxRunning = 0;

    const result = await mapConcurrent([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      if (running > maxRunning) maxRunning = running;
      // yield to allow other tasks to start if concurrency limit is not enforced
      await new Promise<void>((resolve) => setImmediate(resolve));
      running--;
      return n;
    });

    assert.deepEqual(result, [1, 2, 3, 4, 5]);
    assert.ok(maxRunning <= 2, `Expected max concurrency <= 2, but got ${maxRunning}`);
  });

  test("works correctly with concurrency 1 (serial execution)", async () => {
    const order: number[] = [];

    const result = await mapConcurrent([1, 2, 3], 1, async (n) => {
      order.push(n);
      return n * 10;
    });

    assert.deepEqual(result, [10, 20, 30]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  test("errors thrown by fn propagate", async () => {
    await assert.rejects(
      () =>
        mapConcurrent([1, 2, 3], 2, async (n) => {
          if (n === 2) throw new Error("fail");
          return n;
        }),
      /fail/,
    );
  });

  test("index parameter is passed correctly", async () => {
    const result = await mapConcurrent(["a", "b", "c"], 3, async (_item, idx) => idx);
    assert.deepEqual(result, [0, 1, 2]);
  });
});

describe("mapConcurrent scheduling and results", () => {
  test("returns empty array for empty input", async () => {
    const results = await mapConcurrent([], 4, async (x) => x);
    assert.deepEqual(results, []);
  });

  test("processes all items", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await mapConcurrent(items, 2, async (x) => x * 2);
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
  });

  test("respects order of results", async () => {
    const items = [3, 1, 4, 1, 5];
    const results = await mapConcurrent(items, 3, async (x) => x * 10);
    assert.deepEqual(results, [30, 10, 40, 10, 50]);
  });

  test("runs with concurrency 1 (sequential)", async () => {
    const order: number[] = [];
    const items = [0, 1, 2, 3];
    await mapConcurrent(items, 1, async (x, i) => {
      order.push(i);
      return x;
    });
    assert.deepEqual(order, [0, 1, 2, 3]);
  });

  test("runs with high concurrency (all at once)", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await mapConcurrent(items, 100, async (x) => x + 1);
    assert.deepEqual(
      results,
      Array.from({ length: 10 }, (_, i) => i + 1),
    );
  });

  test("actually runs tasks concurrently", async () => {
    // With concurrency=2, tasks should overlap
    const startTimes: number[] = [];
    const items = [0, 1, 2, 3];
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    await mapConcurrent(items, 2, async (x) => {
      startTimes.push(Date.now());
      await delay(20);
      return x;
    });

    // Items 0 and 1 should start at roughly the same time
    assert.equal(startTimes.length, 4);
    const gap01 = Math.abs(startTimes[1] - startTimes[0]);
    const gap12 = Math.abs(startTimes[2] - startTimes[1]);
    assert.ok(gap01 < 15, `Items 0 and 1 should start concurrently (gap: ${gap01}ms)`);
    assert.ok(gap12 >= 10, `Item 2 should wait for a slot (gap: ${gap12}ms)`);
  });

  test("propagates errors from tasks", async () => {
    const items = [1, 2, 3];
    await assert.rejects(
      mapConcurrent(items, 2, async (x) => {
        if (x === 2) throw new Error("task failed");
        return x;
      }),
      /task failed/,
    );
  });
});
