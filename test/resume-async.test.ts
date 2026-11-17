import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findLatestResumableSubagentCalls, recoveryWorkerLabels } from "../resume.js";
import { buildSubagentDetails, type SingleResult } from "../types.js";
import { assistantSubagentCall, makeCtx, makeResult, subagentToolResult, tasks, userText } from "./fixtures/resume.js";
import { messageEntry } from "./helpers/extension.js";

// Records as the extension writes them: launch receipts hold -1 placeholders,
// and every run publishes one completion with its job id and task index.
const names = ["Ada", "Bo"];

function worker(index: number, overrides: Partial<SingleResult> = {}): SingleResult {
  return makeResult({
    ...tasks[index],
    name: names[index],
    sessionDir: `/workers/${index}`,
    exitCode: -1,
    stopReason: undefined,
    errorMessage: undefined,
    stderr: "",
    ...overrides,
  });
}

const finished = (index: number, overrides: Partial<SingleResult> = {}) =>
  worker(index, { exitCode: 0, stopReason: "stop", ...overrides });
const failed = (index: number) => worker(index, { exitCode: 1, stopReason: "error", errorMessage: "boom" });
const stopped = (index: number) => worker(index, { exitCode: 130, stopReason: "aborted" });

function launch(id: string, indexes = [0, 1]): SessionEntry[] {
  const details = Object.assign(
    buildSubagentDetails(
      "parallel",
      "spawn",
      null,
      indexes.map((index) => worker(index)),
    ),
    { asyncJobId: id },
  );
  return [
    assistantSubagentCall(
      id,
      indexes.map((index) => tasks[index]),
    ),
    subagentToolResult(id, details, false),
  ];
}

let completionCount = 0;
function completion(jobId: string, taskIndex: number, result: SingleResult, extra: object = {}): SessionEntry {
  return messageEntry(
    {
      role: "custom",
      customType: "subagent_completion",
      content: "done",
      display: true,
      details: Object.assign(buildSubagentDetails("single", "spawn", null, [result]), {
        asyncJobId: jobId,
        asyncTaskIndex: taskIndex,
        ...extra,
      }),
      timestamp: Date.now(),
    },
    `completion-${completionCount++}`,
  );
}

const pending = (entries: SessionEntry[]) =>
  findLatestResumableSubagentCalls(makeCtx(entries)).map((plan) => ({
    id: plan.previousToolCallId,
    indexes: plan.taskIndexes,
    names: plan.details?.results.map((result) => result.name),
  }));

test("failed, stopped and successful workers are final; only placeholders without a completion recover", () => {
  assert.deepEqual(pending([...launch("L"), completion("L", 0, failed(0)), completion("L", 1, finished(1))]), []);
  assert.deepEqual(
    pending([...launch("L"), completion("L", 0, stopped(0), { silentStopped: true }), userText("next")]),
    [{ id: "L", indexes: [1], names: ["Bo"] }],
  );
});

test("a later message resume of the worker closes its stale launch slot", () => {
  const base = [...launch("L"), completion("L", 1, finished(1))];
  assert.deepEqual(pending(base), [{ id: "L", indexes: [0], names: ["Ada"] }]);
  for (const outcome of [finished(0, { task: "follow-up" }), failed(0)])
    assert.deepEqual(pending([...base, completion("message-call", 0, outcome)]), []);
  // A fork resumes under the same name in another session directory.
  assert.deepEqual(pending([...base, completion("message-call", 0, finished(0, { sessionDir: "/fork" }))]), []);
});

test("recoveries fold into the original launch and close it however they end", () => {
  const recovered = [...launch("L"), completion("L", 1, finished(1)), ...launch("R", [0])];
  assert.deepEqual(pending(recovered), [{ id: "L", indexes: [0], names: ["Ada"] }]);
  assert.deepEqual(pending([...recovered, completion("R", 0, failed(0))]), []);
  assert.deepEqual(pending([...recovered, ...launch("R2", [0])]), [{ id: "L", indexes: [0], names: ["Ada"] }]);
});

test("a delayed completion of a superseded run cannot close the newer run", () => {
  const entries = [
    ...launch("L"),
    completion("L", 1, finished(1)),
    ...launch("R", [0]),
    completion("L", 0, stopped(0)),
  ];
  assert.deepEqual(pending(entries), [{ id: "L", indexes: [0], names: ["Ada"] }]);
});

test("a completion for its own job and index closes the slot without worker identity", () => {
  const anonymous = worker(0, { exitCode: 0, stopReason: "stop", name: undefined, sessionDir: undefined });
  assert.deepEqual(pending([...launch("L"), completion("L", 0, anonymous), completion("L", 1, finished(1))]), []);
});

test("a completion recorded before its receipt still closes the slot", () => {
  const [call, receipt] = launch("L");
  assert.deepEqual(pending([call, completion("L", 0, finished(0)), receipt, completion("L", 1, failed(1))]), []);
});

test("labels name exactly the workers a recovery restarts", () => {
  const plans = findLatestResumableSubagentCalls(makeCtx([...launch("L"), completion("L", 0, finished(0))]));
  assert.deepEqual(recoveryWorkerLabels(plans), ["Bo (reviewer)"]);
});
