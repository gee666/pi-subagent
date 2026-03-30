import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseSubagentMode, getSubagentMode, DEFAULT_SUBAGENTS_MODE } from "../index.js";

describe("DEFAULT_SUBAGENTS_MODE", () => {
  test("is subprocess", () => {
    assert.equal(DEFAULT_SUBAGENTS_MODE, "subprocess");
  });
});

describe("parseSubagentMode", () => {
  test("undefined returns subprocess", () => {
    assert.equal(parseSubagentMode(undefined), "subprocess");
  });

  test("'subprocess' returns subprocess", () => {
    assert.equal(parseSubagentMode("subprocess"), "subprocess");
  });

  test("'SUBPROCESS' returns subprocess (case-insensitive)", () => {
    assert.equal(parseSubagentMode("SUBPROCESS"), "subprocess");
  });

  test("'sdk' returns sdk", () => {
    assert.equal(parseSubagentMode("sdk"), "sdk");
  });

  test("'SDK' returns sdk (case-insensitive)", () => {
    assert.equal(parseSubagentMode("SDK"), "sdk");
  });

  test("'  sdk  ' returns sdk (trims whitespace)", () => {
    assert.equal(parseSubagentMode("  sdk  "), "sdk");
  });

  test("'invalid' returns null", () => {
    assert.equal(parseSubagentMode("invalid"), null);
  });

  test("empty string returns null", () => {
    assert.equal(parseSubagentMode(""), null);
  });

  test("number 42 returns null", () => {
    assert.equal(parseSubagentMode(42), null);
  });

  test("null returns null", () => {
    assert.equal(parseSubagentMode(null), null);
  });
});

describe("getSubagentMode", () => {
  const ENV_KEY = "PI_SUBAGENTS_MODE";

  test("returns subprocess when PI_SUBAGENTS_MODE is not set", () => {
    const saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    try {
      assert.equal(getSubagentMode(), "subprocess");
    } finally {
      if (saved !== undefined) process.env[ENV_KEY] = saved;
    }
  });

  test("returns sdk when PI_SUBAGENTS_MODE=sdk", () => {
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = "sdk";
    try {
      assert.equal(getSubagentMode(), "sdk");
    } finally {
      if (saved !== undefined) process.env[ENV_KEY] = saved;
      else delete process.env[ENV_KEY];
    }
  });

  test("returns subprocess when PI_SUBAGENTS_MODE=subprocess", () => {
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = "subprocess";
    try {
      assert.equal(getSubagentMode(), "subprocess");
    } finally {
      if (saved !== undefined) process.env[ENV_KEY] = saved;
      else delete process.env[ENV_KEY];
    }
  });

  test("returns subprocess (fallback) when PI_SUBAGENTS_MODE=garbage", () => {
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = "garbage";
    try {
      assert.equal(getSubagentMode(), "subprocess");
    } finally {
      if (saved !== undefined) process.env[ENV_KEY] = saved;
      else delete process.env[ENV_KEY];
    }
  });
});
