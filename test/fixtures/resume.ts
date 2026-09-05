import { SessionManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { buildSubagentDetails, emptyUsage, type SingleResult } from "../../types.js";

type FixtureMessage =
  | Pick<AssistantMessage, "role" | "content" | "stopReason" | "timestamp" | "errorMessage">
  | UserMessage
  | ToolResultMessage;
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
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

export const tasks = [
  { agent: "worker", task: "do work" },
  { agent: "reviewer", task: "review work" },
];

export function messageEntry(message: FixtureMessage, id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message:
      message.role === "assistant"
        ? { api: "anthropic-messages", provider: "anthropic", model: "test", usage: zeroUsage, ...message }
        : message,
  };
}

export function assistantSubagentCall(
  toolCallId = "call-subagent",
  callTasks = tasks,
  idField: "id" | "toolCallId" = "id",
): SessionEntry {
  const call = { type: "toolCall" as const, id: toolCallId, name: "subagent", arguments: { tasks: callTasks } };
  if (idField === "toolCallId") {
    Reflect.deleteProperty(call, "id");
    Reflect.set(call, "toolCallId", toolCallId);
  }
  return messageEntry(
    {
      role: "assistant",
      content: [call],
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    `assistant-${toolCallId}`,
  );
}

export function subagentToolResult(
  toolCallId = "call-subagent",
  details = buildSubagentDetails("parallel", "spawn", null, [makeResult()]),
  isError = true,
): SessionEntry {
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

export function trailingAbortedAssistant(): SessionEntry {
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

export function assistantText(text: string): SessionEntry {
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

export function userText(text: string): SessionEntry {
  return messageEntry(
    {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
    "user-text",
  );
}

function modelChange(provider: string, modelId: string): SessionEntry {
  return {
    type: "model_change",
    id: `model-${provider}-${modelId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    provider,
    modelId,
  };
}

function thinkingLevelChange(): SessionEntry {
  return {
    type: "thinking_level_change",
    id: "thinking-change",
    parentId: null,
    timestamp: new Date().toISOString(),
    thinkingLevel: "medium",
  };
}

export function failedSyntheticResumeTail(): SessionEntry[] {
  return [
    modelChange("pi-subagent-resume", "synthetic-tool-call"),
    thinkingLevelChange(),
    userText("Resuming 2 subagents..."),
    trailingAbortedAssistant(),
    modelChange("anthropic", "claude-sonnet-4-6"),
  ];
}

export function makeCtx(entries: SessionEntry[]): ExtensionContext {
  const sessionManager = SessionManager.inMemory();
  sessionManager.getLeafId = () => entries.at(-1)?.id ?? null;
  sessionManager.getBranch = () => entries;
  sessionManager.getEntries = () => entries;
  return {
    sessionManager,
    get ui(): never {
      throw new Error("UI is not used by resume detection");
    },
    get modelRegistry(): never {
      throw new Error("Model registry is not used by resume detection");
    },
    mode: "json",
    hasUI: false,
    cwd: process.cwd(),
    model: undefined,
    scopedModels: [],
    signal: undefined,
    isIdle: () => true,
    isProjectTrusted: () => false,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "",
  };
}
