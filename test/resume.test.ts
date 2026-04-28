import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentDetails, emptyUsage, type SingleResult } from "../types.js";
import {
  SUBAGENT_SESSION_ROOT_ENV,
  findLatestResumableSubagentCall,
  getDefaultSubagentSessionRoot,
  sameTasks,
} from "../resume.js";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "worker",
    agentSource: "user",
    task: "do work",
    exitCode: 130,
    messages: [],
    stderr: "aborted",
    usage: emptyUsage(),
    toolCalls: {},
    completedTurns: 0,
    turnInProgress: false,
    liveLog: [],
    stopReason: "aborted",
    errorMessage: "Subagent was aborted.",
    ...overrides,
  };
}

const tasks = [
  { agent: "worker", task: "do work" },
  { agent: "reviewer", task: "review work", cwd: "/tmp/project" },
];

function messageEntry(message: any, id: string): any {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  };
}

function assistantSubagentCall(toolCallId = "call-subagent", callTasks = tasks): any {
  return messageEntry(
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: toolCallId,
          name: "subagent",
          arguments: { tasks: callTasks },
        },
      ],
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    `assistant-${toolCallId}`,
  );
}

function subagentToolResult(
  toolCallId = "call-subagent",
  details = buildSubagentDetails("parallel", "spawn", null, [makeResult()]),
  isError = true,
): any {
  return messageEntry(
    {
      role: "toolResult",
      toolName: "subagent",
      toolCallId,
      content: [{ type: "text", text: "aborted" }],
      details,
      isError,
      timestamp: Date.now(),
    },
    `result-${toolCallId}`,
  );
}

function trailingAbortedAssistant(): any {
  return messageEntry(
    {
      role: "assistant",
      content: [],
      stopReason: "aborted",
      errorMessage: "Request aborted",
      timestamp: Date.now(),
    },
    "assistant-aborted-cleanup",
  );
}

function assistantText(text: string): any {
  return messageEntry(
    {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
    "assistant-text",
  );
}

function userText(text: string): any {
  return messageEntry(
    {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
    "user-text",
  );
}

function makeCtx(entries: any[]): any {
  return {
    sessionManager: {
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => entries,
      getEntries: () => entries,
    },
  };
}

describe("findLatestResumableSubagentCall", () => {
  test("resumes an unfinished subagent result at the end of the branch", () => {
    const plan = findLatestResumableSubagentCall(makeCtx([
      assistantSubagentCall(),
      subagentToolResult(),
    ]));

    assert.ok(plan);
    assert.equal(plan.previousToolCallId, "call-subagent");
    assert.deepEqual(plan.tasks, tasks);
    assert.equal(plan.details?.results[0].stopReason, "aborted");
  });

  test("still resumes when Pi appends only a trailing aborted assistant cleanup message", () => {
    const plan = findLatestResumableSubagentCall(makeCtx([
      assistantSubagentCall(),
      subagentToolResult(),
      trailingAbortedAssistant(),
    ]));

    assert.ok(plan);
    assert.equal(plan.previousToolCallId, "call-subagent");
  });

  test("does not resume when real assistant progress happened after the unfinished subagent", () => {
    const plan = findLatestResumableSubagentCall(makeCtx([
      assistantSubagentCall(),
      subagentToolResult(),
      assistantText("I handled this another way."),
    ]));

    assert.equal(plan, null);
  });

  test("does not resume when a user message happened after the unfinished subagent", () => {
    const plan = findLatestResumableSubagentCall(makeCtx([
      assistantSubagentCall(),
      subagentToolResult(),
      userText("Never mind, do something else."),
    ]));

    assert.equal(plan, null);
  });

  test("resumes a call with no tool result yet when that call is last", () => {
    const plan = findLatestResumableSubagentCall(makeCtx([
      assistantSubagentCall("in-flight"),
    ]));

    assert.ok(plan);
    assert.equal(plan.previousToolCallId, "in-flight");
    assert.deepEqual(plan.tasks, tasks);
    assert.equal(plan.details, undefined);
  });

  test("resumes a parallel call with missing result entries", () => {
    const partialSuccessDetails = buildSubagentDetails("parallel", "spawn", null, [
      makeResult({ exitCode: 0, stopReason: "stop", errorMessage: undefined, stderr: "" }),
    ]);
    const plan = findLatestResumableSubagentCall(makeCtx([
      assistantSubagentCall(),
      subagentToolResult("call-subagent", partialSuccessDetails, false),
    ]));

    assert.ok(plan);
    assert.equal(plan.previousToolCallId, "call-subagent");
  });

  test("does not resume a successfully finished subagent call", () => {
    const successDetails = buildSubagentDetails("parallel", "spawn", null, [
      makeResult({ exitCode: 0, stopReason: "stop", errorMessage: undefined, stderr: "" }),
      makeResult({ agent: "reviewer", task: "review work", exitCode: 0, stopReason: "stop", errorMessage: undefined, stderr: "" }),
    ]);
    const plan = findLatestResumableSubagentCall(makeCtx([
      assistantSubagentCall(),
      subagentToolResult("call-subagent", successDetails, false),
    ]));

    assert.equal(plan, null);
  });

  test("selects the unfinished call with the latest activity, not insertion order", () => {
    const firstTasks = [{ agent: "first", task: "first task" }];
    const secondTasks = [{ agent: "second", task: "second task" }];
    const bothCalls = messageEntry(
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "first-call", name: "subagent", arguments: { tasks: firstTasks } },
          { type: "toolCall", id: "second-call", name: "subagent", arguments: { tasks: secondTasks } },
        ],
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      "assistant-both",
    );

    const plan = findLatestResumableSubagentCall(makeCtx([
      bothCalls,
      subagentToolResult("second-call", buildSubagentDetails("single", "spawn", null, [makeResult({ agent: "second", task: "second task" })])),
      subagentToolResult("first-call", buildSubagentDetails("single", "spawn", null, [makeResult({ agent: "first", task: "first task" })])),
    ]));

    assert.ok(plan);
    assert.equal(plan.previousToolCallId, "first-call");
    assert.deepEqual(plan.tasks, firstTasks);
  });

  test("returns the latest unfinished subagent call on the active branch", () => {
    const firstTasks = [{ agent: "first", task: "first task" }];
    const secondTasks = [{ agent: "second", task: "second task" }];
    const plan = findLatestResumableSubagentCall(makeCtx([
      assistantSubagentCall("first-call", firstTasks),
      subagentToolResult("first-call"),
      assistantSubagentCall("second-call", secondTasks),
      subagentToolResult("second-call"),
    ]));

    assert.ok(plan);
    assert.equal(plan.previousToolCallId, "second-call");
    assert.deepEqual(plan.tasks, secondTasks);
  });
});

describe("subagent session root", () => {
  test("nested subagents inherit the top-level session root", () => {
    const previous = process.env[SUBAGENT_SESSION_ROOT_ENV];
    process.env[SUBAGENT_SESSION_ROOT_ENV] = "/tmp/pi-subagent-root";
    try {
      const root = getDefaultSubagentSessionRoot({
        sessionManager: {
          getSessionDir: () => "/tmp/pi-subagent-root/parent-session/tool-call/0",
        },
      } as any);
      assert.equal(root, "/tmp/pi-subagent-root");
    } finally {
      if (previous === undefined) delete process.env[SUBAGENT_SESSION_ROOT_ENV];
      else process.env[SUBAGENT_SESSION_ROOT_ENV] = previous;
    }
  });
});

describe("sameTasks", () => {
  test("matches exact task configuration including cwd", () => {
    assert.equal(sameTasks(tasks, [...tasks]), true);
    assert.equal(sameTasks(tasks, tasks.map(({ agent, task }) => ({ agent, task }))), false);
  });
});
