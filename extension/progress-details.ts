import {
  type SingleResult,
  type SubagentDetails,
  type SubagentUsageSummary,
  type UsageStats,
  emptyUsage,
  aggregateUsage,
  getFinalOutput,
  isSubagentDetails,
  isSubagentToolName,
} from "../types.js";
import { isRecord, recordArray } from "../types/records.js";
import type { TranscriptMessage } from "../types/transcript.js";
import { headPreview, outputPreview, progressLog, PROGRESS_ERROR_CHARS } from "./progress-preview.js";

function usage(value: UsageStats | undefined): UsageStats {
  const result = emptyUsage();
  for (const key of Object.keys(result) as Array<keyof UsageStats>) {
    if (typeof value?.[key] === "number") result[key] = value[key];
  }
  return result;
}

function summary(value: SubagentUsageSummary | undefined): SubagentUsageSummary | undefined {
  if (!value) return undefined;
  return {
    subagentCount: value.subagentCount,
    subagentIds: value.subagentIds?.filter((id) => typeof id === "string"),
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    costUsd: value.costUsd,
    turns: value.turns,
  };
}

function strings(value: object, keys: string[]): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const item: unknown = Reflect.get(value, key);
      return typeof item === "string" ? [[key, item]] : [];
    }),
  );
}

/** These tasks are structural matching keys, not tool-argument previews. Keep them exact. */
function delegationArguments(value: unknown): Record<string, unknown> {
  const args = isRecord(value) ? value : {};
  const result: Record<string, unknown> = {};
  if (Array.isArray(args.tasks)) {
    result.tasks = recordArray(args.tasks).map((task) => strings(task, ["agent", "name", "intelligence", "task"]));
  }
  const resume = (item: Record<string, unknown>) => strings(item, ["subagent", "name", "task", "prompt"]);
  if (Array.isArray(args.resumes)) result.resumes = recordArray(args.resumes).map(resume);
  else if (isRecord(args.resumes)) result.resumes = resume(args.resumes);
  return result;
}

// Finalized transcript messages are immutable. Cache only their wire projection,
// never mutable SingleResult objects. Weak keys release it with the transcript.
const projectedMessages = new WeakMap<object, TranscriptMessage | null>();

function messagesForProgress(value: unknown): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const message of Array.isArray(value) ? value : []) {
    if (!isRecord(message)) continue;
    if (projectedMessages.has(message)) {
      const projected = projectedMessages.get(message);
      if (projected) messages.push(projected);
      continue;
    }
    const start = messages.length;
    if (message.role === "assistant") {
      const content = recordArray(message.content)
        .filter((part) => part.type === "toolCall" && isSubagentToolName(part.name))
        .map((part) => ({
          type: "toolCall",
          ...strings(part, ["name", "id", "toolCallId"]),
          arguments: delegationArguments(part.arguments),
        }));
      if (content.length) messages.push({ role: "assistant", content });
    } else if (
      (message.role === "toolResult" && isSubagentToolName(message.toolName)) ||
      (message.role === "custom" && message.customType === "subagent_completion")
    ) {
      // Invalid details cannot supply tree/accounting information. Never forward
      // their original content as a fallback, since it can include arbitrary blobs.
      if (!isSubagentDetails(message.details)) continue;
      messages.push({
        role: message.role,
        ...strings(message, ["toolName", "toolCallId", "customType"]),
        isError: message.isError === true,
        details: slimDetailsForProgress(message.details),
      });
    }
    projectedMessages.set(message, messages.length > start ? messages[messages.length - 1] : null);
  }
  return messages;
}

function resultForProgress(result: SingleResult): SingleResult {
  const liveNestedSubagents = result.liveNestedSubagents
    ? Object.fromEntries(
        Object.entries(result.liveNestedSubagents)
          .filter(([, details]) => isSubagentDetails(details))
          .map(([id, details]) => [id, slimDetailsForProgress(details)]),
      )
    : undefined;
  return {
    agent: result.agent,
    agentSource: result.agentSource,
    task: result.task,
    name: result.name,
    intelligence: result.intelligence,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    model: result.model,
    startedAt: result.startedAt,
    ...(result.idle ? { idle: true } : {}),
    lastActionAt: result.lastActionAt,
    // Identity references preserve usage-count deduplication across resumes.
    budget: result.budget ? { directory: result.budget.directory } : undefined,
    sessionDir: result.sessionDir,
    sessionId: result.sessionId,
    usage: usage(result.usage),
    subtreeUsageSummary: summary(result.subtreeUsageSummary),
    priorDescendantUsageSummary: summary(result.priorDescendantUsageSummary),
    messages: messagesForProgress(result.messages),
    liveNestedSubagents,
    liveLog: progressLog(result.liveLog),
    stderr: typeof result.stderr === "string" ? result.stderr.slice(-PROGRESS_ERROR_CHARS) : "",
    errorMessage: headPreview(result.errorMessage, PROGRESS_ERROR_CHARS),
    finalOutput:
      result.exitCode === -1 ? undefined : outputPreview(getFinalOutput(result.messages, result.finalOutput)),
    // Empty compatibility fields, never a copy of process state or tool arguments.
    toolCalls: {},
    completedTurns: 0,
    turnInProgress: false,
  };
}

/** Transient wire projection only. Never use this in durable results or saved transcripts. */
export function slimDetailsForProgress(details: SubagentDetails): SubagentDetails {
  return {
    ...strings(details, ["asyncJobId"]),
    ...(Number.isInteger(Reflect.get(details, "asyncTaskIndex"))
      ? { asyncTaskIndex: Reflect.get(details, "asyncTaskIndex") }
      : {}),
    mode: details.mode,
    delegationMode: details.delegationMode,
    projectAgentsDir: null,
    results: details.results.map(resultForProgress),
    usageSummary: summary(details.usageSummary),
    aggregatedUsage: usage(details.aggregatedUsage ?? aggregateUsage(details.results)),
    aggregatedToolCalls: {},
    usageTree: [],
  };
}
