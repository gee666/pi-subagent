/**
 * Shared type definitions for the subagent extension.
 */

import type { Message } from "@mariozechner/pi-ai";

/** Context mode for delegated runs. */
export type DelegationMode = "spawn" | "fork";

/** Default context mode for delegated runs. */
export const DEFAULT_DELEGATION_MODE: DelegationMode = "spawn";

/** Aggregated token usage from a subagent run. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Tool calls made by an agent: toolName → call count */
export type ToolCallCounts = Record<string, number>;

/** Result of a single subagent invocation. */
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "builtin" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	toolCalls: ToolCallCounts;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** A node in the per-subagent usage tree (own stats + recursive children) */
export interface UsageTreeNode {
  agent: string;
  task: string;
  /** Token/cost usage for this agent's own turns only */
  ownUsage: UsageStats;
  /** Tool calls this agent made directly (all tools, including "subagent") */
  ownToolCalls: ToolCallCounts;
  /** ownUsage summed with all descendants recursively */
  aggregatedUsage: UsageStats;
  /** ownToolCalls merged with all descendants recursively */
  aggregatedToolCalls: ToolCallCounts;
  /** Nested subagent invocations, recursively populated */
  children: UsageTreeNode[];
}

/** Metadata attached to every tool result for rendering. */
export interface SubagentDetails {
	mode: "single" | "parallel";
	delegationMode: DelegationMode;
	projectAgentsDir: string | null;
	results: SingleResult[];
  /** Usage summed across all results and all their nested descendants */
  aggregatedUsage: UsageStats;
  /** Tool calls merged across all results and all their nested descendants */
  aggregatedToolCalls: ToolCallCounts;
  /** Per-agent recursive usage breakdown */
  usageTree: UsageTreeNode[];
}

/** Nested subagent tool result captured from a delegated run. */
export interface NestedSubagentResult {
	details: SubagentDetails;
	isError: boolean;
	toolCallId: string;
}

/** A display-friendly representation of a message part. */
export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Create an empty UsageStats object. */
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Sum usage across multiple results. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

/** Add delta into total in-place (contextTokens is a snapshot—not summed, left as-is in total) */
export function addUsage(total: UsageStats, delta: UsageStats): void {
  total.input      += delta.input;
  total.output     += delta.output;
  total.cacheRead  += delta.cacheRead;
  total.cacheWrite += delta.cacheWrite;
  total.cost       += delta.cost;
  total.turns      += delta.turns;
}

/** Merge tool call counts from `source` into `target` in-place */
export function mergeToolCalls(target: ToolCallCounts, source: ToolCallCounts): void {
  for (const [name, count] of Object.entries(source)) {
    target[name] = (target[name] ?? 0) + count;
  }
}

/** Extract all tool calls made by assistant turns in a message list */
export function extractToolCalls(messages: Message[]): ToolCallCounts {
  const counts: ToolCallCounts = {};
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of (msg.content as any[]) ?? []) {
      if ((part as any)?.type !== "toolCall") continue;
      const name: string = typeof (part as any).name === "string" ? (part as any).name : "unknown";
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

/** Build a UsageTreeNode for one result, recursing into nested subagent tool results */
function buildUsageTreeNode(result: SingleResult): UsageTreeNode {
  const children: UsageTreeNode[] = [];
  for (const nested of getNestedSubagentResults(result.messages)) {
    for (const nestedResult of nested.details.results) {
      children.push(buildUsageTreeNode(nestedResult));
    }
  }

  const ownUsage = result.usage;
  const ownToolCalls: ToolCallCounts = result.toolCalls ?? extractToolCalls(result.messages);

  const aggregatedUsage = emptyUsage();
  addUsage(aggregatedUsage, ownUsage);
  for (const child of children) addUsage(aggregatedUsage, child.aggregatedUsage);

  const aggregatedToolCalls: ToolCallCounts = { ...ownToolCalls };
  for (const child of children) mergeToolCalls(aggregatedToolCalls, child.aggregatedToolCalls);

  return {
    agent: result.agent,
    task: result.task,
    ownUsage,
    ownToolCalls,
    aggregatedUsage,
    aggregatedToolCalls,
    children,
  };
}

/**
 * Construct a complete SubagentDetails with aggregated stats.
 * This replaces the plain object literal previously used by makeDetailsFactory.
 */
export function buildSubagentDetails(
  mode: "single" | "parallel",
  delegationMode: DelegationMode,
  projectAgentsDir: string | null,
  results: SingleResult[],
): SubagentDetails {
  const usageTree = results.map(buildUsageTreeNode);

  const aggregatedUsage = emptyUsage();
  const aggregatedToolCalls: ToolCallCounts = {};
  for (const node of usageTree) {
    addUsage(aggregatedUsage, node.aggregatedUsage);
    mergeToolCalls(aggregatedToolCalls, node.aggregatedToolCalls);
  }

  return {
    mode,
    delegationMode,
    projectAgentsDir,
    results,
    aggregatedUsage,
    aggregatedToolCalls,
    usageTree,
  };
}

/** Whether a result represents an error. */
export function isResultError(r: SingleResult): boolean {
	return r.exitCode > 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

/** Check whether a value looks like SubagentDetails. */
export function isSubagentDetails(value: unknown): value is SubagentDetails {
	if (!value || typeof value !== "object") return false;
	const maybe = value as Partial<SubagentDetails>;
	return (maybe.mode === "single" || maybe.mode === "parallel") &&
		(maybe.delegationMode === "spawn" || maybe.delegationMode === "fork") &&
		Array.isArray(maybe.results);
}

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/** Extract all display-worthy items from a message history. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
				}
			}
		}
	}
	return items;
}

/** Extract nested subagent tool results from a message history. */
export function getNestedSubagentResults(messages: Message[]): NestedSubagentResult[] {
	const results: NestedSubagentResult[] = [];
	for (const msg of messages) {
		if (msg.role !== "toolResult") continue;
		if (msg.toolName !== "subagent") continue;
		if (!isSubagentDetails(msg.details)) continue;
		results.push({
			details: msg.details,
			isError: msg.isError,
			toolCallId: msg.toolCallId,
		});
	}
	return results;
}

function collectSubagentErrorLinesFromDetails(
	details: SubagentDetails,
	lines: string[],
	prefix = "",
): void {
	for (const result of details.results) {
		if (isResultError(result)) {
			const reason = result.errorMessage || result.stderr || result.stopReason || "failed";
			lines.push(`${prefix}${result.agent}: ${reason}`);
		}
		const nested = getNestedSubagentResults(result.messages);
		for (const child of nested) {
			if (child.isError) {
				collectSubagentErrorLinesFromDetails(
					child.details,
					lines,
					`${prefix}${result.agent} -> `,
				);
			}
		}
	}
}

/** Summarize nested subagent failures captured in a message history. */
export function getNestedSubagentErrorSummary(messages: Message[]): string | null {
	const lines: string[] = [];
	for (const nested of getNestedSubagentResults(messages)) {
		if (!nested.isError) continue;
		collectSubagentErrorLinesFromDetails(nested.details, lines);
	}
	if (lines.length === 0) return null;
	return `Nested subagent failure: ${lines.join("; ")}`;
}
