import {
  isSubagentToolName,
  type DisplayItem,
  type NestedSubagentResult,
  type SubagentDetails,
  type SingleResult,
  type ToolCallCounts,
} from "./contracts.js";
import { isSubagentDetails, isResultError } from "./outcomes.js";
import { isRecord, recordArray } from "./records.js";
import { buildUsageSummary, emptyUsageSummary, usageSummaryToUsageStats } from "./usage.js";

export interface AsyncExecutionKey {
  jobId: string;
  taskIndex: number;
}

export function asyncJobId(details: SubagentDetails): string | undefined {
  const id = Reflect.get(details, "asyncJobId");
  return typeof id === "string" ? id : undefined;
}

/** A resume of the same worker is a different execution, not a duplicate charge. */
export function subagentExecutionId(result: SingleResult): string | undefined {
  if (!result.sessionDir || result.startedAt === undefined) return undefined;
  return JSON.stringify([result.sessionDir, result.startedAt]);
}

/** Extract all tool calls made by assistant turns in a message list */
export function extractToolCalls(messages: unknown): ToolCallCounts {
  const counts: ToolCallCounts = {};
  for (const msg of recordArray(messages)) {
    if (msg.role !== "assistant") continue;
    for (const part of recordArray(msg.content)) {
      if (part.type !== "toolCall") continue;
      const name: string = typeof part.name === "string" ? part.name : "unknown";
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

const finalOutputs = new WeakMap<unknown[], { length: number; last: unknown; output?: string }>();

/** Extract the last assistant text. Finalized histories are immutable and append-only. */
export function getFinalOutput(messages: unknown, fallback?: string): string {
  if (!Array.isArray(messages)) return fallback ?? "";
  const history: unknown[] = messages;
  const cached = finalOutputs.get(history);
  const appended =
    cached && cached.length <= history.length && (cached.length === 0 || history[cached.length - 1] === cached.last);
  let output = appended ? cached.output : undefined;
  search: for (let i = history.length - 1; i >= (appended ? cached.length : 0); i--) {
    const msg = history[i];
    if (isRecord(msg) && msg.role === "assistant" && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const part: unknown = msg.content[j];
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          output = part.text;
          break search;
        }
      }
    }
  }
  finalOutputs.set(history, { length: history.length, last: history[history.length - 1], output });
  return output ?? fallback ?? "";
}

/** Extract all display-worthy items from a message history. */
export function getDisplayItems(messages: unknown): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of recordArray(messages)) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of recordArray(msg.content)) {
        if (part?.type === "text" && typeof part.text === "string") {
          items.push({ type: "text", text: part.text });
        } else if (part?.type === "toolCall" && typeof part.name === "string") {
          items.push({
            type: "toolCall",
            name: part.name,
            args: isRecord(part.arguments) ? part.arguments : {},
          });
        }
      }
    }
  }
  return items;
}

// Summarize each subtree separately, then union identities once for the batch.
// addUsageSummary otherwise recopies the growing identity list for every worker.
function batchUsageSummary(results: SingleResult[]) {
  const total = emptyUsageSummary();
  const ids = new Set<string>();
  for (const result of results) {
    const summary = buildUsageSummary([result]);
    let overlap = 0;
    for (const id of new Set(summary.subagentIds ?? [])) {
      if (ids.has(id)) overlap++;
      else ids.add(id);
    }
    total.subagentCount += Math.max(0, summary.subagentCount - overlap);
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "costUsd",
      "turns",
    ] as const) {
      total[key] += summary[key];
    }
  }
  if (ids.size) total.subagentIds = [...ids];
  return total;
}

/** Reconcile async launch placeholders with their individual durable completions. */
export function getNestedSubagentResults(messages: unknown): NestedSubagentResult[] {
  const history = recordArray(messages);
  const results: NestedSubagentResult[] = [];
  const launches = new Map<string, NestedSubagentResult>();
  for (const msg of history) {
    if (msg.role !== "toolResult" || !isSubagentToolName(msg.toolName) || !isSubagentDetails(msg.details)) continue;
    const nested = {
      details: msg.details,
      isError: Boolean(msg.isError),
      toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : "",
    };
    results.push(nested);
    if (nested.toolCallId) launches.set(nested.toolCallId, nested);
  }
  const changed = new Map<NestedSubagentResult, SingleResult[]>();
  const successful = new Map<string, SingleResult>();
  const recoveryKey = (result: SingleResult, exact: boolean) =>
    JSON.stringify([result.sessionDir, result.task, ...(exact ? [result.startedAt] : [])]);
  for (const msg of history) {
    if (msg.role !== "custom" || msg.customType !== "subagent_completion" || !isSubagentDetails(msg.details)) continue;
    for (const result of msg.details.results) {
      if (result.sessionDir && result.exitCode === 0 && !isResultError(result)) {
        successful.set(recoveryKey(result, false), result);
        successful.set(recoveryKey(result, true), result);
      }
    }
    const jobId = asyncJobId(msg.details);
    const launch = jobId ? launches.get(jobId) : undefined;
    const taskIndex = Reflect.get(msg.details, "asyncTaskIndex");
    if (
      launch &&
      Number.isInteger(taskIndex) &&
      taskIndex >= 0 &&
      taskIndex < launch.details.results.length &&
      msg.details.results.length === 1
    ) {
      let merged = changed.get(launch);
      if (!merged) changed.set(launch, (merged = [...launch.details.results]));
      merged[taskIndex] = msg.details.results[0];
    } else {
      results.push({ details: msg.details, isError: Boolean(msg.isError), toolCallId: jobId ?? "" });
    }
  }
  // A synthetic recovery has a new tool-call ID but reuses the worker session.
  // Let its later successful completion close the original unfinished slot too.
  for (const launch of launches.values()) {
    if (!asyncJobId(launch.details)) continue;
    const current = changed.get(launch) ?? launch.details.results;
    const merged = current.map((result) => {
      if (!result.sessionDir || (result.exitCode !== -1 && !isResultError(result))) return result;
      return successful.get(recoveryKey(result, result.startedAt !== undefined)) ?? result;
    });
    if (changed.has(launch) || merged.some((result, index) => result !== current[index])) changed.set(launch, merged);
  }
  // Finalize each batch once, rather than rebuilding it after every sibling.
  for (const [launch, merged] of changed) {
    const usageSummary = batchUsageSummary(merged);
    launch.details = {
      ...launch.details,
      results: merged,
      usageSummary,
      aggregatedUsage: usageSummaryToUsageStats(usageSummary)!,
    };
    launch.isError = merged.some(isResultError);
  }
  // Replayed successful siblings can appear in more than one recovered batch.
  // Retain their recovery refs, but account for each execution only once.
  const seen = new Set<string>();
  for (const nested of results) {
    const unique = nested.details.results.filter((result) => {
      if (!isRecord(result)) return true;
      const id = result.exitCode !== -1 ? subagentExecutionId(result) : undefined;
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (unique.length !== nested.details.results.length) {
      nested.details = { ...nested.details, usageSummary: batchUsageSummary(unique) };
    }
  }
  return results;
}

function collectSubagentErrorLinesFromDetails(details: SubagentDetails, lines: string[], prefix = ""): void {
  for (const result of details.results) {
    if (isResultError(result)) {
      const reason = result.errorMessage || result.stderr || result.stopReason || "failed";
      lines.push(`${prefix}${result.agent}: ${reason}`);
    }
    const nested = getNestedSubagentResults(result.messages ?? []);
    for (const child of nested) {
      // Older pi-subagent versions returned an unsupported `isError` field
      // from execute(), so Pi persisted the outer tool result as successful.
      // Inspect durable child outcomes regardless of that unreliable flag.
      collectSubagentErrorLinesFromDetails(child.details, lines, `${prefix}${result.agent} -> `);
    }
  }
}

/** Summarize nested subagent failures captured in a message history. */
export function getNestedSubagentErrorSummary(messages: unknown): string | null {
  const lines: string[] = [];
  for (const nested of getNestedSubagentResults(messages)) {
    // Do not trust the outer tool-result error bit: releases before Pi 0.83
    // could persist failed subagents with isError=false.
    collectSubagentErrorLinesFromDetails(nested.details, lines);
  }
  if (lines.length === 0) return null;
  return `Nested subagent failure: ${lines.join("; ")}`;
}
