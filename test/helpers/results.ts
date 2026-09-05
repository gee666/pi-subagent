import { emptyUsage, type SingleResult } from "../../types.js";
import type { TranscriptMessage } from "../../types/transcript.js";

export function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "test-agent",
    agentSource: "user",
    task: "do something",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    toolCalls: {},
    completedTurns: 0,
    turnInProgress: false,
    liveLog: [],
    ...overrides,
  };
}

export function makeTextMessage(text: string): TranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  };
}

export function makeToolCallMessage(toolName: string, args: Record<string, unknown> = {}): TranscriptMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", name: toolName, arguments: args, toolCallId: "tc1" }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  };
}

export function makeToolResultMessage(toolName: string, details: unknown, isError = false): TranscriptMessage {
  return {
    role: "toolResult",
    toolName,
    toolCallId: "tc1",
    content: [{ type: "text", text: "result" }],
    details,
    isError,
  };
}

export function makeRunningResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return makeResult({ exitCode: -1, ...overrides });
}
