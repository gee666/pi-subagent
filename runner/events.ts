import { isTranscriptMessage, type TranscriptMessage } from "../types/transcript.js";
import {
  type LiveLogEntry,
  type SingleResult,
  MAX_LIVE_LOG_ENTRIES,
  isSubagentDetails,
  isSubagentToolName,
} from "../types.js";
import { isRecord } from "../types/records.js";

const SEMANTIC_EVENT_TYPES = new Set([
  "message_end",
  "tool_result_end",
  "subagent_progress",
  "turn_start",
  "turn_end",
  "tool_execution_start",
  "tool_execution_end",
]);

/** Unknown and malformed JSONL records must not interrupt the child stream. */
export function parseRpcEvent(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isProgressOnlyEvent(line: string, result: SingleResult): boolean {
  const event = parseRpcEvent(line);
  return event?.type === "subagent_progress" && processRpcEvent(event, result);
}

function pushLiveLog(result: SingleResult, entry: LiveLogEntry): void {
  if (entry.at === undefined) entry.at = Date.now();
  result.liveLog.push(entry);
  if (result.liveLog.length > MAX_LIVE_LOG_ENTRIES) result.liveLog.shift();
}

function messageDedupKey(value: unknown): string {
  const message = isRecord(value) ? value : {};
  if (typeof message.id === "string") return `id:${message.id}`;
  return JSON.stringify({
    role: message.role,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    usage: message.usage,
  });
}

function hasMessage(result: SingleResult, message: TranscriptMessage): boolean {
  const key = messageDedupKey(message);
  return result.messages.some((existing) => messageDedupKey(existing) === key);
}

function clearNestedProgress(result: SingleResult, message: TranscriptMessage): void {
  if (isSubagentToolName(message.toolName) && typeof message.toolCallId === "string") {
    delete result.liveNestedSubagents?.[message.toolCallId];
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function processJsonLine(line: string, result: SingleResult): boolean {
  const event = parseRpcEvent(line);
  return event !== undefined && processRpcEvent(event, result);
}

/** Apply an already parsed event. Protocol handling and stderr reuse this path. */
export function processRpcEvent(event: Record<string, unknown>, result: SingleResult): boolean {
  if (typeof event.type === "string" && SEMANTIC_EVENT_TYPES.has(event.type)) {
    result.lastActionAt = typeof event.timestamp === "number" ? event.timestamp : Date.now();
  }

  if (event.type === "message_end" && isTranscriptMessage(event.message)) {
    const msg = event.message;
    // Current RPC emits tool results as message_end; retain tool_result_end below
    // only for older child streams. Both must retire transient nested snapshots.
    if (msg.role === "toolResult") clearNestedProgress(result, msg);
    if (hasMessage(result, msg)) return true;
    // Preserve legacy and extension message shapes, not just current SDK roles.
    result.messages.push(msg);

    if (msg.role === "assistant") {
      result.usage.turns++;
      const usage = msg.usage;
      if (isRecord(usage)) {
        result.usage.input += numberOrZero(usage.input);
        result.usage.output += numberOrZero(usage.output);
        result.usage.cacheRead += numberOrZero(usage.cacheRead);
        result.usage.cacheWrite += numberOrZero(usage.cacheWrite);
        result.usage.cost += numberOrZero(isRecord(usage.cost) ? usage.cost.total : undefined);
        result.usage.contextTokens = numberOrZero(usage.totalTokens);
      }
      if (typeof msg.model === "string" && msg.model && msg.model !== "synthetic-tool-call") result.model = msg.model;
      if (typeof msg.stopReason === "string" && msg.stopReason) {
        result.stopReason = msg.stopReason;
        // Successful retries supersede the previous transport error.
        result.errorMessage = typeof msg.errorMessage === "string" && msg.errorMessage ? msg.errorMessage : undefined;
      }
    }
    return true;
  }

  if (event.type === "tool_result_end" && isTranscriptMessage(event.message)) {
    const msg = event.message;
    if (!hasMessage(result, msg)) result.messages.push(msg);
    clearNestedProgress(result, msg);
    return true;
  }

  if (event.type === "subagent_progress") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (toolCallId && isSubagentDetails(event.details)) {
      result.liveNestedSubagents ??= {};
      result.liveNestedSubagents[toolCallId] = event.details;
      return true;
    }
    return false;
  }

  if (event.type === "turn_start") {
    result.turnInProgress = true;
    pushLiveLog(result, { kind: "turn_start" });
    return true;
  }

  if (event.type === "turn_end") {
    result.completedTurns++;
    result.turnInProgress = false;
    const usage = isRecord(event.message) && isRecord(event.message.usage) ? event.message.usage : {};
    pushLiveLog(result, {
      kind: "turn_end",
      turn: result.completedTurns,
      inputTokens: numberOrZero(usage.input),
      outputTokens: numberOrZero(usage.output),
    });
    return true;
  }

  if (
    event.type === "tool_execution_start" &&
    typeof event.toolCallId === "string" &&
    typeof event.toolName === "string"
  ) {
    const args = isRecord(event.args) ? event.args : {};
    result.liveToolExecutions ??= {};
    result.liveToolExecutions[event.toolCallId] = { toolName: event.toolName, args };
    pushLiveLog(result, { kind: "tool_start", toolName: event.toolName, args });
    return true;
  }

  if (
    event.type === "tool_execution_end" &&
    typeof event.toolCallId === "string" &&
    typeof event.toolName === "string"
  ) {
    if (result.liveToolExecutions) delete result.liveToolExecutions[event.toolCallId];
    pushLiveLog(result, { kind: "tool_end", toolName: event.toolName });
    return true;
  }

  return false;
}
