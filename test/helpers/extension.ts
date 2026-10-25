import assert from "node:assert/strict";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFauxCore, fauxAssistantMessage, type Provider, type Model, type Api } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  SessionEntry,
  SessionMessageEntry,
  CustomEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import subagentExtension from "../../index.js";
import { buildSubagentDetails, isSubagentDetails, isResultError, type SubagentDetails } from "../../types.js";
import { makeResult } from "./results.js";
import { serializedDetails } from "./json.js";

/** A partial host double, not a full host implementation. Unexpected API access fails immediately. */
export function hostDouble<T extends object>(members: Partial<T>): T {
  return new Proxy(members, {
    get(target, key, receiver) {
      assert.ok(key in target, `Unexpected test host access: ${String(key)}`);
      return Reflect.get(target, key, receiver);
    },
  }) as T;
}

export function model(provider = "anthropic", id = "claude-sonnet-4-6", api = "anthropic-messages"): Model<Api> {
  return createFauxCore({ provider, api, models: [{ id }] }).getModel();
}

export function messageEntry(message: SessionMessageEntry["message"], id: string): SessionMessageEntry {
  return { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message };
}

export function customEntry(customType: string, data: unknown): CustomEntry {
  return {
    type: "custom",
    id: `custom-${customType}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    data,
  };
}

export const resumeTasks = [
  { agent: "worker", task: "do work" },
  { agent: "reviewer", task: "review work" },
];

export function resumeBranch(finished = false): SessionEntry[] {
  const results = resumeTasks.map(({ agent, task }) =>
    makeResult({
      agent,
      task,
      exitCode: finished ? 0 : 130,
      stderr: finished ? "" : "aborted",
      stopReason: finished ? "stop" : "aborted",
      errorMessage: finished ? undefined : "Subagent was aborted.",
    }),
  );
  return [
    messageEntry(
      fauxAssistantMessage(
        { type: "toolCall", id: "call-1", name: "subagent", arguments: { tasks: resumeTasks } },
        { stopReason: "toolUse" },
      ),
      "assistant-call-1",
    ),
    messageEntry(
      {
        role: "toolResult",
        toolName: "subagent",
        toolCallId: "call-1",
        content: [{ type: "text", text: finished ? "done" : "aborted" }],
        details: serializedDetails(buildSubagentDetails("parallel", "spawn", null, results)),
        isError: !finished,
        timestamp: Date.now(),
      },
      "result-call-1",
    ),
  ];
}

type EventName = ExtensionEvent["type"];
type EventOf<K extends EventName> = Extract<ExtensionEvent, { type: K }>;
type Handler<K extends EventName> = (event: EventOf<K>, ctx: ExtensionContext) => unknown;
const defaults = {
  input: { type: "input", text: "", source: "rpc" },
  session_start: { type: "session_start", reason: "new" },
  session_shutdown: { type: "session_shutdown", reason: "quit" },
  session_tree: { type: "session_tree", newLeafId: null, oldLeafId: null },
  message_end: { type: "message_end", message: fauxAssistantMessage("") },
  message_start: { type: "message_start", message: fauxAssistantMessage("") },
  context: { type: "context", messages: [] },
  before_agent_start: {
    type: "before_agent_start",
    prompt: "",
    systemPrompt: "base",
    systemPromptOptions: {
      cwd: process.cwd(),
      selectedTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      appendSystemPrompt: "",
      sections: {},
      contextFiles: [],
      skills: [],
    },
  },
} satisfies {
  [
    K in
      | "input"
      | "session_start"
      | "session_shutdown"
      | "session_tree"
      | "message_end"
      | "message_start"
      | "context"
      | "before_agent_start"
  ]: EventOf<K>;
};

type TSchema = ToolDefinition["parameters"];

type CapturedTool = {
  description: string;
  parameters: TSchema;
  execute(id: string, args: unknown, ctx: ExtensionContext): Promise<AgentToolResult<unknown>>;
};

export function createExtensionHarness(options: { confirmAnswer?: boolean } = {}) {
  const handlers = new Map<EventName, Array<(event: ExtensionEvent, ctx: ExtensionContext) => unknown>>();
  const providers = new Map<string, Provider>();
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  let activeTools = ["read", "bash", "subagent"];
  const calls = {
    setModel: [] as Model<Api>[],
    sentUserMessages: [] as string[],
    sentMessages: [] as Array<{
      message: Parameters<ExtensionAPI["sendMessage"]>[0];
      options: Parameters<ExtensionAPI["sendMessage"]>[1];
    }>,
    confirms: 0,
  };
  let entriesToAppend: SessionEntry[] | undefined;

  function on<K extends EventName>(name: K, handler: Handler<K>): void {
    const dispatch = (event: ExtensionEvent, ctx: ExtensionContext) => {
      assert.equal(event.type, name);
      // The registration key and checked discriminant establish this generic association.
      return handler(event as EventOf<K>, ctx);
    };
    handlers.set(name, [...(handlers.get(name) ?? []), dispatch]);
  }

  function registerTool<T extends TSchema, D>(tool: ToolDefinition<T, D>): void {
    if (!tools.has(tool.name)) activeTools.push(tool.name);
    tools.set(tool.name, {
      description: tool.description,
      parameters: tool.parameters,
      async execute(id, args, ctx) {
        // Both tools validate here. Do not bypass their SDK argument-preparation boundary.
        assert.ok(tool.prepareArguments, `Missing argument preparation for ${tool.name}`);
        return tool.execute(id, tool.prepareArguments(args), undefined, undefined, ctx);
      },
    });
  }

  const pi = hostDouble<ExtensionAPI>({
    registerFlag() {},
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getFlag: () => undefined,
    registerProvider(provider) {
      assert.notEqual(typeof provider, "string", "These tests exercise public Provider registration only");
      if (typeof provider !== "string") providers.set(provider.id, provider);
    },
    registerTool,
    // SDK overloads describe the same event-key association checked by the dispatcher above.
    on: on as ExtensionAPI["on"],
    getActiveTools: () => [...activeTools],
    setActiveTools(names) {
      activeTools = [...names];
    },
    async setModel(value) {
      calls.setModel.push(value);
      return true;
    },
    sendUserMessage(text) {
      assert.equal(typeof text, "string");
      if (typeof text === "string") calls.sentUserMessages.push(text);
    },
    sendMessage(message, options) {
      calls.sentMessages.push({ message, options });
    },
    appendEntry(customType, data) {
      entriesToAppend?.push(customEntry(customType, data));
    },
  });
  subagentExtension(pi);

  function makeCtx(entries: SessionEntry[], overrides: Partial<ExtensionContext> = {}): ExtensionContext {
    entriesToAppend = entries;
    return hostDouble<ExtensionContext>({
      cwd: process.cwd(),
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      isProjectTrusted: () => false,
      model: model(),
      modelRegistry: hostDouble<ExtensionContext["modelRegistry"]>({
        find: (provider, id) => model(provider, id, "openai-responses"),
        getApiKeyAndHeaders: async () => ({ ok: true }),
      }),
      sessionManager: hostDouble<ExtensionContext["sessionManager"]>({
        getLeafId: () => entries.at(-1)?.id ?? null,
        getBranch: () => entries,
        getEntries: () => entries,
        getSessionId: () => "session-1",
        getSessionFile: () => undefined,
        getSessionDir: () => path.resolve("tmp", "harness-sessions", String(process.pid)),
        getHeader: () => null,
      }),
      ui: hostDouble<ExtensionContext["ui"]>({
        confirm: async () => {
          calls.confirms++;
          return options.confirmAnswer ?? true;
        },
        notify() {},
        select: async () => undefined,
        input: async () => undefined,
        setStatus() {},
        setWidget() {},
        theme: hostDouble<ExtensionContext["ui"]["theme"]>({ fg: (_color, text) => text }),
      }),
      ...overrides,
    });
  }

  return {
    calls,
    tools,
    commands,
    pi,
    getActiveTools: () => [...activeTools],
    makeCtx,
    provider(id: string): Provider {
      const found = providers.get(id);
      assert.ok(found);
      return found;
    },
    tool(name: string): CapturedTool {
      const found = tools.get(name);
      assert.ok(found);
      return found;
    },
    async emit<K extends keyof typeof defaults>(name: K, fields: Partial<EventOf<K>>, ctx: ExtensionContext) {
      const event = { ...defaults[name], ...fields, type: name };
      const results: unknown[] = [];
      for (const handler of handlers.get(name) ?? []) {
        const result = await handler(event, ctx);
        if (result !== undefined) results.push(result);
      }
      return results;
    },
    /** Keep call() immediate; completion-sensitive tests opt into this async boundary. */
    async callAndWait(name: string, id: string, args: unknown, ctx: ExtensionContext) {
      const after = calls.sentMessages.length;
      const started = await this.call(name, id, args, ctx);
      if (started.isError) return { ...started, started, completions: [] };
      assert.match(
        JSON.stringify(started.content),
        name === "subagents" ? /\d+ started, \d+ queued:/ : /started in the background/,
      );
      for (const result of started.details.results) assert.equal(result.exitCode, -1);
      const expected = name === "subagents" ? started.details.results.length : 1;
      assert.ok(expected > 0);
      const deadline = Date.now() + 10000;
      let completions = calls.sentMessages.slice(after);
      while (completions.length < expected && Date.now() < deadline) {
        await delay(10);
        completions = calls.sentMessages.slice(after);
      }
      assert.equal(completions.length, expected, `Missing completion for ${name} ${id}`);
      const results = completions.flatMap(({ message, options }) => {
        assert.equal(message.customType, "subagent_completion");
        assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
        assert.equal(message.display, true);
        assert.ok(isSubagentDetails(message.details));
        assert.equal(message.details.results.length, 1);
        assert.notEqual(message.details.results[0].exitCode, -1);
        return message.details.results;
      });
      // Completion order is not launch order. Preserve the call's task alignment.
      if (name === "message_subagent") {
        assert.ok(args && typeof args === "object" && "name" in args);
        assert.equal(results[0].name, args.name, "completion must belong to the messaged worker");
      }
      const ordered =
        name === "subagents"
          ? started.details.results.map((pending) => {
              const index = results.findIndex((result) =>
                pending.name
                  ? result.name === pending.name
                  : result.agent === pending.agent && result.task === pending.task,
              );
              assert.notEqual(index, -1, "completion must match a launched task");
              return results.splice(index, 1)[0];
            })
          : results;
      return {
        content: completions.map(({ message }) => {
          assert.ok(typeof message.content === "string");
          return { type: "text" as const, text: message.content };
        }),
        details: buildSubagentDetails(
          started.details.mode,
          started.details.delegationMode,
          started.details.projectAgentsDir,
          ordered,
        ),
        isError: ordered.some(isResultError),
        started,
        completions,
      };
    },
    async call(name: string, id: string, args: unknown, ctx: ExtensionContext) {
      const tool = tools.get(name);
      assert.ok(tool);
      const result = await tool.execute(id, args, ctx);
      assert.ok(isSubagentDetails(result.details));
      assert.ok(result.content.every((part) => part.type === "text"));
      const details: SubagentDetails = result.details;
      return { content: result.content, details, isError: "isError" in result && result.isError === true };
    },
  };
}
