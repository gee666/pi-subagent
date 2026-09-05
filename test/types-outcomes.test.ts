import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isResultError,
  isResultSuccess,
  isSubagentDetails,
  prepareResumeArguments,
  subagentDetailsHaveErrors,
  buildSubagentDetails,
} from "../types.js";
import { makeResult } from "./helpers/results.js";

describe("isResultError", () => {
  test("returns false for exit code 0", () => {
    assert.equal(isResultError(makeResult({ exitCode: 0 })), false);
  });

  test("returns true for exit code > 0", () => {
    assert.equal(isResultError(makeResult({ exitCode: 1 })), true);
    assert.equal(isResultError(makeResult({ exitCode: 130 })), true);
  });

  test("returns true for stop reason 'error'", () => {
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "error" })), true);
  });

  test("returns true for stop reason 'aborted'", () => {
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "aborted" })), true);
  });

  test("treats output limits as incomplete failures", () => {
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "length" })), true);
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "incomplete" })), true);
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "max_tokens" })), true);
  });

  test("returns false for successful stop reasons", () => {
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "end_turn" })), false);
    assert.equal(isResultError(makeResult({ exitCode: 0, stopReason: "stop" })), false);
  });

  test("distinguishes live unfinished results from settled success", () => {
    const running = makeResult({ exitCode: -1 });
    assert.equal(isResultError(running), false);
    assert.equal(isResultSuccess(running), false);
    assert.equal(isResultSuccess(makeResult({ exitCode: 0, stopReason: "stop" })), true);
  });
});

describe("resume argument compatibility", () => {
  test("normalizes top-level single-item shorthand", () => {
    assert.deepEqual(prepareResumeArguments({ subagent: "writer-01", task: "continue" }), {
      resumes: [{ subagent: "writer-01", task: "continue" }],
    });
  });

  test("preserves optional budget overrides in the resume shorthand", () => {
    assert.deepEqual(prepareResumeArguments({ subagent: "writer-01", task: "continue", max_agents_allowed: 4 }), {
      resumes: [{ subagent: "writer-01", task: "continue", max_agents_allowed: 4 }],
    });
    assert.deepEqual(
      prepareResumeArguments({ subagent: "writer-01", task: "continue", max_agents_allowed: 0 }),
      { resumes: [{ subagent: "writer-01", task: "continue", max_agents_allowed: 0 }] },
      "invalid overrides must reach validation, not silently disappear",
    );
  });

  test("normalizes an object-valued resumes field", () => {
    assert.deepEqual(prepareResumeArguments({ resumes: { subagent: "writer-01", task: "continue" } }), {
      resumes: [{ subagent: "writer-01", task: "continue" }],
    });
  });
});

// ---------------------------------------------------------------------------
// isSubagentDetails
// ---------------------------------------------------------------------------

describe("isSubagentDetails", () => {
  test("returns true for valid SubagentDetails", () => {
    const d = buildSubagentDetails("single", "spawn", null, []);
    assert.equal(isSubagentDetails(d), true);
  });

  test("returns false for null", () => {
    assert.equal(isSubagentDetails(null), false);
  });

  test("returns false for non-object", () => {
    assert.equal(isSubagentDetails("string"), false);
    assert.equal(isSubagentDetails(42), false);
    assert.equal(isSubagentDetails(undefined), false);
  });

  test("returns false if mode is wrong", () => {
    assert.equal(isSubagentDetails({ mode: "invalid", delegationMode: "spawn", results: [] }), false);
  });

  test("returns false if delegationMode is wrong", () => {
    assert.equal(isSubagentDetails({ mode: "single", delegationMode: "invalid", results: [] }), false);
  });

  test("returns false if results is not array", () => {
    assert.equal(isSubagentDetails({ mode: "single", delegationMode: "spawn", results: null }), false);
  });

  test("detects failed direct children in details", () => {
    const failed = buildSubagentDetails("single", "spawn", null, [makeResult({ stopReason: "length" })]);
    assert.equal(subagentDetailsHaveErrors(failed), true);
    assert.equal(subagentDetailsHaveErrors(buildSubagentDetails("single", "spawn", null, [makeResult()])), false);
  });
});
