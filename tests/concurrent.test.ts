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

    const result = await mapConcurrent(
      [1, 2, 3, 4, 5],
      2,
      async (n) => {
        running++;
        if (running > maxRunning) maxRunning = running;
        // yield to allow other tasks to start if concurrency limit is not enforced
        await new Promise<void>((resolve) => setImmediate(resolve));
        running--;
        return n;
      },
    );

    assert.deepEqual(result, [1, 2, 3, 4, 5]);
    assert.ok(
      maxRunning <= 2,
      `Expected max concurrency <= 2, but got ${maxRunning}`,
    );
  });

  test("works correctly with concurrency 1 (serial execution)", async () => {
    const order: number[] = [];

    const result = await mapConcurrent(
      [1, 2, 3],
      1,
      async (n) => {
        order.push(n);
        return n * 10;
      },
    );

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
    const result = await mapConcurrent(
      ["a", "b", "c"],
      3,
      async (_item, idx) => idx,
    );
    assert.deepEqual(result, [0, 1, 2]);
  });
});
