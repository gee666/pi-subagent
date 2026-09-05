import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  emptyUsage,
  aggregateUsage,
  addUsage,
  mergeToolCalls,
  type UsageStats,
  type ToolCallCounts,
} from "../types.js";
import { makeResult } from "./helpers/results.js";

describe("emptyUsage", () => {
  test("returns zero-valued stats", () => {
    const u = emptyUsage();
    assert.equal(u.input, 0);
    assert.equal(u.output, 0);
    assert.equal(u.cacheRead, 0);
    assert.equal(u.cacheWrite, 0);
    assert.equal(u.cost, 0);
    assert.equal(u.contextTokens, 0);
    assert.equal(u.turns, 0);
  });

  test("returns a new object each time", () => {
    const a = emptyUsage();
    const b = emptyUsage();
    a.input = 999;
    assert.equal(b.input, 0);
  });
});

// ---------------------------------------------------------------------------
// aggregateUsage
// ---------------------------------------------------------------------------

describe("aggregateUsage", () => {
  test("sums across results", () => {
    const r1 = makeResult({
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: 0.01, contextTokens: 0, turns: 1 },
    });
    const r2 = makeResult({
      usage: { input: 20, output: 10, cacheRead: 4, cacheWrite: 2, cost: 0.02, contextTokens: 0, turns: 2 },
    });
    const total = aggregateUsage([r1, r2]);
    assert.equal(total.input, 30);
    assert.equal(total.output, 15);
    assert.equal(total.cacheRead, 6);
    assert.equal(total.cacheWrite, 3);
    assert.equal(Math.round(total.cost * 1000), 30); // 0.03
    assert.equal(total.turns, 3);
  });

  test("returns zeros for empty array", () => {
    const total = aggregateUsage([]);
    assert.deepEqual(total, emptyUsage());
  });
});

// ---------------------------------------------------------------------------
// addUsage
// ---------------------------------------------------------------------------

describe("addUsage", () => {
  test("adds delta into total in-place", () => {
    const total = emptyUsage();
    const delta: UsageStats = {
      input: 5,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
      cost: 0.005,
      contextTokens: 100,
      turns: 1,
    };
    addUsage(total, delta);
    assert.equal(total.input, 5);
    assert.equal(total.output, 3);
    assert.equal(total.turns, 1);
  });

  test("accumulates multiple deltas", () => {
    const total = emptyUsage();
    addUsage(total, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
    addUsage(total, { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 2 });
    assert.equal(total.input, 30);
    assert.equal(total.turns, 3);
  });
});

// ---------------------------------------------------------------------------
// mergeToolCalls
// ---------------------------------------------------------------------------

describe("mergeToolCalls", () => {
  test("merges counts into target", () => {
    const target: ToolCallCounts = { bash: 2 };
    mergeToolCalls(target, { bash: 3, read: 1 });
    assert.equal(target.bash, 5);
    assert.equal(target.read, 1);
  });

  test("handles empty source", () => {
    const target: ToolCallCounts = { bash: 2 };
    mergeToolCalls(target, {});
    assert.equal(target.bash, 2);
  });

  test("handles empty target and source", () => {
    const target: ToolCallCounts = {};
    mergeToolCalls(target, {});
    assert.deepEqual(target, {});
  });

  test("sets new keys from source", () => {
    const target: ToolCallCounts = {};
    mergeToolCalls(target, { newTool: 5 });
    assert.equal(target.newTool, 5);
  });
});
