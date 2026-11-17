import assert from "node:assert/strict";
import test from "node:test";
import { findLatestResumableSubagentCalls } from "../resume.js";
import { buildSubagentDetails } from "../types.js";
import {
  assistantSubagentCall,
  makeCtx,
  makeResult,
  messageEntry,
  subagentToolResult,
  tasks,
} from "./fixtures/resume.js";

// Synchronous launches recover only when their tool call was cut off.
const success = (index: number) =>
  makeResult({ ...tasks[index], exitCode: 0, stopReason: "stop", errorMessage: undefined, stderr: "" });
const failure = (index: number) =>
  makeResult({ ...tasks[index], exitCode: 1, stopReason: "error", errorMessage: "boom", stderr: "boom" });
const aborted = (index: number) => makeResult({ ...tasks[index], sessionDir: `/workers/${index}` });

function recover(results: ReturnType<typeof makeResult>[] | undefined, text = "aborted", isError = true) {
  const result = subagentToolResult(
    "sync",
    results
      ? buildSubagentDetails("parallel", "spawn", null, results)
      : buildSubagentDetails("single", "spawn", null, []),
    isError,
  );
  if (!results && result.type === "message" && result.message.role === "toolResult") {
    result.message.details = {};
    result.message.content = [{ type: "text", text }];
  }
  return findLatestResumableSubagentCalls(makeCtx([assistantSubagentCall("sync"), result]));
}

test("ordinary synchronous failures are final", () => {
  assert.deepEqual(recover([failure(0), failure(1)]), []);
  assert.deepEqual(recover([failure(0), success(1)]), []);
});

test("only the aborted sibling of a mixed synchronous batch recovers", () => {
  const [plan] = recover([failure(0), aborted(1)]);
  assert.deepEqual(plan.tasks, [tasks[1]]);
  assert.deepEqual(plan.taskIndexes, [1]);
  assert.deepEqual(
    plan.details?.results.map((result) => result.sessionDir),
    ["/workers/1"],
  );
});

test("a missing sibling result recovers alone with an unstarted placeholder", () => {
  const [plan] = recover([success(0)], "partial", false);
  assert.deepEqual(plan.tasks, [tasks[1]]);
  assert.deepEqual(plan.taskIndexes, [1]);
  assert.deepEqual(
    plan.details?.results.map((result) => [result.agent, result.exitCode, result.sessionDir]),
    [["reviewer", -1, undefined]],
  );
});

test("rejected launches are not revived, while Pi's abort result is", () => {
  assert.deepEqual(recover(undefined, "Invalid parameters. Provide a non-empty tasks array."), []);
  assert.deepEqual(recover([], "Canceled: project-local agents not approved.", false), []);
  const [plan] = recover(undefined, "Operation aborted");
  assert.deepEqual(plan.tasks, tasks);
  assert.equal(plan.details, undefined);
});

test("a rejected launch result without details is final", () => {
  const rejected = messageEntry(
    {
      role: "toolResult",
      toolName: "subagents",
      toolCallId: "sync",
      content: [{ type: "text", text: "[pi-subagent] Unexpected error: boom" }],
      isError: true,
      timestamp: Date.now(),
    },
    "rejected",
  );
  assert.deepEqual(findLatestResumableSubagentCalls(makeCtx([assistantSubagentCall("sync"), rejected])), []);
});
