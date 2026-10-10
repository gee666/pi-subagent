import assert from "node:assert/strict";
import { test } from "node:test";
import { slimDetailsForProgress } from "../extension/progress.js";
import {
  PROGRESS_ARGUMENT_CHARS,
  PROGRESS_ERROR_CHARS,
  PROGRESS_OUTPUT_CHARS,
  progressLog,
} from "../extension/progress-preview.js";
import { buildLiveSubagentDetails, buildSubagentDetails, MAX_LIVE_LOG_ENTRIES } from "../types.js";
import { makeResult, makeRunningResult, makeToolCallMessage } from "./helpers/results.js";

const details = (results: ReturnType<typeof makeResult>[]) =>
  buildLiveSubagentDetails("parallel", "spawn", null, results);
const wire = (value: ReturnType<typeof details>) => JSON.parse(JSON.stringify(slimDetailsForProgress(value)));

test("progress excludes bulk payloads and arbitrary extra fields at every level", () => {
  const bulk = "DO_NOT_FORWARD_BULK".repeat(100000);
  const child = makeRunningResult({ name: "Child", task: "nested task" });
  const nested = Object.assign(details([child]), { unusedDetail: bulk });
  const call = makeToolCallMessage("subagents", {
    tasks: [{ agent: child.agent, task: child.task, intelligence: "junior", unused: bulk }],
    unusedArgument: bulk,
  });
  Object.assign(call, { unusedMessage: bulk, provider: bulk });
  Object.assign((call.content as object[])[0], { unusedPart: bulk });
  const parent = Object.assign(
    makeRunningResult({
      name: "Parent",
      task: "parent task",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: bulk },
            { type: "text", text: bulk },
          ],
        },
        { role: "toolResult", toolName: "read", content: [{ type: "image", data: bulk }] },
        call,
        {
          role: "toolResult",
          toolName: "subagents",
          toolCallId: "completed",
          content: [{ type: "text", text: bulk }],
          details: buildSubagentDetails("single", "spawn", null, [makeResult({ name: "Done" })]),
          isError: false,
        },
        { role: "toolResult", toolName: "subagents", content: bulk, details: { invalid: bulk } },
      ],
      liveLog: [{ kind: "tool_start", toolName: "write", args: { path: "out.txt", content: bulk, unused: bulk } }],
      liveToolExecutions: { write: { toolName: "write", args: { path: "out.txt", content: bulk } } },
      finalOutput: bulk,
      liveNestedSubagents: { tc1: nested },
    }),
    { unusedResult: bulk },
  );
  Object.assign(parent.usage, { unusedUsage: bulk });
  Object.assign(parent.liveLog[0], { unusedLog: bulk });
  const source = Object.assign(details([parent]), { unusedDetail: bulk });
  const sourceBefore = JSON.stringify(source);
  const projected = wire(source);
  const json = JSON.stringify(projected);
  assert.ok(json.length < 6000, `expected compact structural status, got ${json.length} characters`);
  assert.ok(!json.includes("DO_NOT_FORWARD_BULK"));
  assert.deepEqual(projected.usageTree, []);
  assert.deepEqual(projected.aggregatedToolCalls, {});
  assert.equal(projected.results[0].liveToolExecutions, undefined);
  assert.equal(projected.results[0].finalOutput, undefined);
  assert.deepEqual(projected.results[0].liveLog[0].args, { path: "out.txt" });
  assert.equal(projected.results[0].messages.length, 2);
  assert.equal(projected.results[0].messages[1].content, undefined);
  assert.equal(projected.results[0].messages[0].provider, undefined);
  assert.equal(JSON.stringify(source), sourceBefore, "projection must never mutate transcript or runtime state");
  assert.deepEqual(wire(projected), projected, "forwarding through another ancestor must remain stable");
});

test("errors and completed output have fixed preview limits without truncating durable results", () => {
  const huge = "answer".repeat(100000);
  const result = makeResult({
    messages: [{ role: "assistant", content: [{ type: "text", text: huge }] }],
    stderr: `start-${huge}-end`,
    errorMessage: huge,
  });
  const progress = wire(details([result])).results[0];
  assert.ok(progress.finalOutput.length <= PROGRESS_OUTPUT_CHARS);
  assert.ok(progress.errorMessage.length <= PROGRESS_ERROR_CHARS);
  assert.equal(progress.stderr.length, PROGRESS_ERROR_CHARS);
  assert.ok(progress.stderr.endsWith("-end"));
  assert.equal(progress.messages.length, 0);
  assert.equal(buildSubagentDetails("single", "spawn", null, [result]).results[0].finalOutput, huge);
  const multiline = makeResult({ finalOutput: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") });
  assert.equal(
    wire(details([multiline])).results[0].finalOutput,
    "line 14\nline 15\nline 16\nline 17\nline 18\nline 19",
  );
});

test("tool activity includes only bounded display arguments", () => {
  const huge = "x".repeat(100000);
  for (const [toolName, args, keys] of [
    ["bash", { command: huge, env: huge }, ["command"]],
    ["read", { path: huge, file_path: huge, offset: huge }, ["path", "file_path"]],
    ["write", { path: huge, content: huge }, ["path"]],
    ["edit", { path: huge, edits: [{ oldText: huge, newText: huge }] }, ["path"]],
    ["grep", { path: huge, pattern: huge, extra: huge }, ["pattern", "path"]],
    ["find", { path: huge, pattern: huge, extra: huge }, ["pattern", "path"]],
    ["custom", { arbitrary: huge }, []],
  ] as const) {
    const log = progressLog([{ kind: "tool_start", toolName, args }]);
    assert.equal(log[0].kind, "tool_start");
    if (log[0].kind !== "tool_start") throw new Error("unexpected log kind");
    assert.deepEqual(Object.keys(log[0].args), keys);
    for (const value of Object.values(log[0].args)) assert.ok(String(value).length <= PROGRESS_ARGUMENT_CHARS);
  }
  const logs = progressLog(
    Array.from({ length: 100 }, (_, at) => ({ kind: "tool_start", toolName: "bash", args: { command: huge }, at })),
  );
  assert.equal(logs.length, MAX_LIVE_LOG_ENTRIES);
  assert.equal(logs[0].at, 100 - MAX_LIVE_LOG_ENTRIES);
  const log = progressLog([
    { kind: "tool_start", toolName: "subagents", args: { tasks: Array(100).fill({ agent: huge, task: huge }) } },
    { kind: "tool_start", toolName: "resume_subagents", args: { resumes: { subagent: huge, task: huge } } },
  ]);
  assert.ok(JSON.stringify(log).length < 2500);
  assert.ok(!JSON.stringify(log).includes('"task"'));
});

test("unknown payload growth does not increase serialized progress size", () => {
  const payload = (length: number) => {
    const bulk = "z".repeat(length);
    const result = Object.assign(
      makeRunningResult({
        messages: [{ role: "toolResult", toolName: "bash", content: bulk, details: { output: bulk } }],
        liveLog: [{ kind: "tool_start", toolName: "edit", args: { path: "file.ts", edits: bulk } }],
      }),
      { unknownBlob: bulk },
    );
    return JSON.stringify(wire(details([result]))).length;
  };
  assert.equal(payload(10), payload(2_000_000));
});
