import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deepMerge } from "../shared.js";

describe("deepMerge", () => {
  test("returns a new object, does not mutate target or source", () => {
    const target = { a: 1 };
    const source = { b: 2 };
    const result = deepMerge(target, source);
    assert.deepEqual(result, { a: 1, b: 2 });
    assert.deepEqual(target, { a: 1 });
    assert.deepEqual(source, { b: 2 });
    assert.notEqual(result, target);
  });

  test("source primitive overwrites target primitive", () => {
    const result = deepMerge({ a: 1 }, { a: 99 });
    assert.deepEqual(result, { a: 99 });
  });

  test("keys only in target are preserved", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 20 });
    assert.deepEqual(result, { a: 1, b: 20 });
  });

  test("keys only in source are added", () => {
    const result = deepMerge({ a: 1 }, { b: 2, c: 3 });
    assert.deepEqual(result, { a: 1, b: 2, c: 3 });
  });

  test("nested plain objects are merged recursively", () => {
    const target = { a: { x: 1, y: 2 } };
    const source = { a: { y: 99, z: 3 } };
    const result = deepMerge(target, source);
    assert.deepEqual(result, { a: { x: 1, y: 99, z: 3 } });
  });

  test("deeply nested merge does not mutate originals", () => {
    const target = { a: { b: { c: 1 } } };
    const source = { a: { b: { d: 2 } } };
    const result = deepMerge(target, source);
    assert.deepEqual(result, { a: { b: { c: 1, d: 2 } } });
    assert.deepEqual(target, { a: { b: { c: 1 } } });
  });

  test("source array overwrites target array (no element-wise merge)", () => {
    const result = deepMerge({ arr: [1, 2, 3] }, { arr: [4, 5] });
    assert.deepEqual(result, { arr: [4, 5] });
  });

  test("source array overwrites target plain object", () => {
    const result = deepMerge({ a: { x: 1 } }, { a: [1, 2] as unknown as object });
    assert.deepEqual(result, { a: [1, 2] });
  });

  test("source plain object overwrites target array", () => {
    const result = deepMerge({ a: [1, 2] as unknown as object }, { a: { x: 1 } });
    assert.deepEqual(result, { a: { x: 1 } });
  });

  test("merging two empty objects produces empty object", () => {
    assert.deepEqual(deepMerge({}, {}), {});
  });

  test("merging into empty target returns clone of source", () => {
    const source = { a: 1, b: { c: 2 } };
    const result = deepMerge({}, source);
    assert.deepEqual(result, source);
    assert.notEqual(result, source);
  });

  test("null values in source are written to output", () => {
    const result = deepMerge({ a: 1 }, { a: null as unknown as object });
    assert.deepEqual(result, { a: null });
  });
});
