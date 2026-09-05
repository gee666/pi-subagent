import {
  isSubagentToolName,
  type DisplayItem,
  type NestedSubagentResult,
  type SubagentDetails,
  type ToolCallCounts,
} from "./contracts.js";
import { isSubagentDetails, isResultError } from "./outcomes.js";
import { isRecord, recordArray } from "./records.js";

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

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: unknown, fallback?: string): string {
  const history = recordArray(messages);
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const part: unknown = msg.content[j];
        if (!isRecord(part)) continue;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
      }
    }
  }
  return fallback ?? "";
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

/** Extract nested subagent tool results from a message history. */
export function getNestedSubagentResults(messages: unknown): NestedSubagentResult[] {
  const results: NestedSubagentResult[] = [];
  for (const msg of recordArray(messages)) {
    if (msg.role !== "toolResult") continue;
    if (!isSubagentToolName(msg.toolName)) continue;
    if (!isSubagentDetails(msg.details)) continue;
    results.push({
      details: msg.details,
      isError: Boolean(msg.isError),
      toolCallId: typeof msg.toolCallId === "string" ? msg.toolCallId : "",
    });
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
