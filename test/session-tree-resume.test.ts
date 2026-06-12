/**
 * Verifies that navigating the session tree in the TUI (Esc navigation) back
 * to a point with an unfinished subagent call offers to resume the subagents,
 * mirroring the session_start resume behavior.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import subagentExtension from "../index.js";
import { buildSubagentDetails, emptyUsage, type SingleResult } from "../types.js";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";

const tasks = [
  { agent: "worker", task: "do work" },
  { agent: "reviewer", task: "review work" },
];

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

function messageEntry(message: any, id: string): any {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

function assistantSubagentCall(toolCallId = "call-subagent"): any {
  return messageEntry(
    {
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "subagent", arguments: { tasks } }],
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    `assistant-${toolCallId}`,
  );
}

function subagentToolResult(toolCallId: string, results: SingleResult[], isError: boolean): any {
  return messageEntry(
    {
      role: "toolResult",
      toolName: "subagent",
      toolCallId,
      content: [{ type: "text", text: isError ? "aborted" : "done" }],
      details: buildSubagentDetails("parallel", "spawn", null, results),
      isError,
      timestamp: Date.now(),
    },
    `result-${toolCallId}`,
  );
}

function unfinishedBranch(): any[] {
  return [
    assistantSubagentCall("call-1"),
    subagentToolResult("call-1", [makeResult(), makeResult({ agent: "reviewer", task: "review work" })], true),
  ];
}

function finishedBranch(): any[] {
  const finished = (agent: string, task: string) =>
    makeResult({ agent, task, exitCode: 0, stderr: "", stopReason: "stop", errorMessage: undefined });
  return [
    assistantSubagentCall("call-1"),
    subagentToolResult("call-1", [finished("worker", "do work"), finished("reviewer", "review work")], false),
  ];
}

interface Harness {
  emit: (event: string, evt: any, ctx: any) => Promise<void>;
  calls: {
    setModel: any[];
    sentUserMessages: string[];
    confirms: number;
  };
  makeCtx: (entries: any[], overrides?: Record<string, any>) => any;
}

function createHarness(opts: { confirmAnswer?: boolean } = {}): Harness {
  const handlers = new Map<string, Function[]>();
  const calls = { setModel: [] as any[], sentUserMessages: [] as string[], confirms: 0 };

  const pi: any = {
    registerFlag() {},
    registerProvider() {},
    registerTool() {},
    registerCommand() {},
    getFlag: () => undefined,
    getActiveTools: () => ["subagent"],
    setActiveTools() {},
    async setModel(model: any) {
      calls.setModel.push(model);
      return true;
    },
    sendUserMessage(text: string) {
      calls.sentUserMessages.push(text);
    },
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  subagentExtension(pi);

  const makeCtx = (entries: any[], overrides: Record<string, any> = {}): any => ({
    cwd: process.cwd(),
    hasUI: true,
    isIdle: () => true,
    model: { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages" },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id, api: "openai-responses" }),
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
    sessionManager: {
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => entries,
      getEntries: () => entries,
      getSessionId: () => "session-1",
      getSessionDir: () => process.cwd(),
    },
    ui: {
      confirm: async () => {
        calls.confirms++;
        return opts.confirmAnswer ?? true;
      },
      notify() {},
      select: async () => undefined,
      input: async () => undefined,
      setStatus() {},
    },
    ...overrides,
  });

  return {
    calls,
    makeCtx,
    emit: async (event, evt, ctx) => {
      for (const handler of handlers.get(event) ?? []) await handler(evt, ctx);
    },
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("session_tree subagent resume", () => {
  test("offers resume and starts the synthetic resume turn after navigating to an unfinished subagent point", async () => {
    const harness = createHarness();
    const ctx = harness.makeCtx(unfinishedBranch());

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" }, ctx);
    await wait(150);

    assert.equal(harness.calls.confirms, 1, "expected the resume confirmation prompt");
    const resumeModel = harness.calls.setModel.find((m) => m?.provider === RESUME_PROVIDER);
    assert.ok(resumeModel, "expected a switch to the synthetic resume model");
    assert.equal(resumeModel.id, RESUME_MODEL_ID);
    assert.deepEqual(harness.calls.sentUserMessages, ["Resuming 2 subagents..."]);
  });

  test("ignores extension-driven tree navigation", async () => {
    const harness = createHarness();
    const ctx = harness.makeCtx(unfinishedBranch());

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x", fromExtension: true }, ctx);
    await wait(120);

    assert.equal(harness.calls.confirms, 0);
    assert.equal(harness.calls.setModel.length, 0);
    assert.deepEqual(harness.calls.sentUserMessages, []);
  });

  test("does nothing when the navigated branch has no unfinished subagent call", async () => {
    const harness = createHarness();
    const ctx = harness.makeCtx(finishedBranch());

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" }, ctx);
    await wait(120);

    assert.equal(harness.calls.confirms, 0);
    assert.equal(harness.calls.setModel.length, 0);
    assert.deepEqual(harness.calls.sentUserMessages, []);
  });

  test("declining the resume prompt leaves the model and conversation untouched", async () => {
    const harness = createHarness({ confirmAnswer: false });
    const ctx = harness.makeCtx(unfinishedBranch());

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" }, ctx);
    await wait(120);

    assert.equal(harness.calls.confirms, 1);
    assert.equal(harness.calls.setModel.length, 0);
    assert.deepEqual(harness.calls.sentUserMessages, []);
  });

  test("does not offer resume while the agent is busy", async () => {
    const harness = createHarness();
    const ctx = harness.makeCtx(unfinishedBranch(), { isIdle: () => false });

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" }, ctx);
    await wait(120);

    assert.equal(harness.calls.confirms, 0);
    assert.deepEqual(harness.calls.sentUserMessages, []);
  });
});
