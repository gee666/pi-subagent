/**
 * Drives the synthetic subagent-resume provider directly.
 *
 * The resume flow works by registering a provider whose `streamSimple` handler
 * injects the resumed `subagent` tool call(s) as a canned assistant turn. Since
 * pi 0.80 this is built on pi-ai's first-class faux provider (`createFauxCore`
 * + `fauxAssistantMessage`/`fauxToolCall`) rather than a hand-rolled event
 * stream. These tests capture the registered provider config and exercise its
 * `streamSimple` to prove the injected turn is well-formed.
 */
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import subagentExtension from "../index.js";
import {
  buildSubagentDetails,
  emptyUsage,
  SUBAGENT_TOOL_NAME,
  type SingleResult,
} from "../types.js";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";

const RESUME_STATE_KEY = "__piSubagentResumeState";

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

function unfinishedBranch(): any[] {
  return [
    messageEntry(
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { tasks } }],
        stopReason: "toolUse",
        timestamp: Date.now(),
      },
      "assistant-call-1",
    ),
    messageEntry(
      {
        role: "toolResult",
        toolName: "subagent",
        toolCallId: "call-1",
        content: [{ type: "text", text: "aborted" }],
        details: buildSubagentDetails("parallel", "spawn", null, [
          makeResult(),
          makeResult({ agent: "reviewer", task: "review work" }),
        ]),
        isError: true,
        timestamp: Date.now(),
      },
      "result-call-1",
    ),
  ];
}

interface Captured {
  config: any;
  emit: (event: string, evt: any, ctx: any) => Promise<void>;
  makeCtx: (entries: any[]) => any;
}

function setup(): Captured {
  const handlers = new Map<string, Function[]>();
  let config: any;
  const pi: any = {
    registerFlag() {},
    registerProvider(_name: string, cfg: any) {
      config = cfg;
    },
    registerTool() {},
    registerCommand() {},
    getFlag: () => undefined,
    getActiveTools: () => ["subagent"],
    setActiveTools() {},
    async setModel() {
      return true;
    },
    sendUserMessage() {},
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  subagentExtension(pi);

  const makeCtx = (entries: any[]): any => ({
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
    ui: { notify() {}, confirm: async () => true, select: async () => undefined, input: async () => undefined, setStatus() {} },
  });

  return {
    config,
    makeCtx,
    emit: async (event, evt, ctx) => {
      for (const handler of handlers.get(event) ?? []) await handler(evt, ctx);
    },
  };
}

async function drain(stream: any): Promise<any[]> {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function userPrompt(text: string) {
  return { messages: [{ role: "user", content: [{ type: "text", text }] }] };
}

const resumeModel = { provider: RESUME_PROVIDER, id: RESUME_MODEL_ID, api: "openai-responses" };

describe("synthetic resume provider streamSimple", () => {
  beforeEach(() => {
    // The synthetic resume state is a process-global; isolate each test.
    (globalThis as any)[RESUME_STATE_KEY] = undefined;
  });

  test("registers a provider with a streamSimple handler and the resume model", () => {
    const h = setup();
    assert.equal(typeof h.config?.streamSimple, "function");
    assert.ok(
      h.config.models.some((m: any) => m.id === RESUME_MODEL_ID),
      "expected the synthetic resume model to be registered",
    );
  });

  test("injects the resumed subagent tool call as a faux assistant turn", async () => {
    const h = setup();
    // Point the provider at a branch with an unfinished subagent call.
    await h.emit("message_end", { type: "message_end" }, h.makeCtx(unfinishedBranch()));

    const stream = await h.config.streamSimple(resumeModel, userPrompt("Resuming 2 subagents..."), {});
    const events = await drain(stream);

    const toolCallEnds = events.filter((e) => e.type === "toolcall_end");
    assert.equal(toolCallEnds.length, 1, "expected exactly one injected tool call");
    assert.equal(toolCallEnds[0].toolCall.name, SUBAGENT_TOOL_NAME);
    assert.deepEqual(toolCallEnds[0].toolCall.arguments.tasks, tasks);
    assert.ok(
      String(toolCallEnds[0].toolCall.id).startsWith("resume_subagent_"),
      "tool call id should carry the resume prefix",
    );

    const done = events.find((e) => e.type === "done");
    assert.ok(done, "expected a done event");
    assert.equal(done.reason, "toolUse");
    assert.equal(done.message.provider, RESUME_PROVIDER);
    assert.equal(done.message.model, RESUME_MODEL_ID);
  });

  test("emits an error turn when there is no plan and no fallback model", async () => {
    const h = setup();
    // No latestSessionCtx / plans, and the prompt does not match a resume
    // trigger, so the provider has nothing to inject and no model to forward to.
    const stream = await h.config.streamSimple(resumeModel, userPrompt("hello there"), {});
    const events = await drain(stream);

    const error = events.find((e) => e.type === "error");
    assert.ok(error, "expected an error event");
    assert.match(
      String(error.error?.errorMessage ?? ""),
      /Subagent resume failed/,
    );
    assert.ok(
      !events.some((e) => e.type === "toolcall_end"),
      "no tool call should be injected without a plan",
    );
  });
});
