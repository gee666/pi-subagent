/**
 * Shared type definitions for the subagent extension.
 */

import type { Message } from "@mariozechner/pi-ai";

/** Context mode for delegated runs. */
export type DelegationMode = "spawn";

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

/** Durable aggregate usage stored on a parent subagent tool result. */
export interface SubagentUsageSummary {
	subagentCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	turns: number;
}

/** Tool calls made by an agent: toolName → call count */
export type ToolCallCounts = Record<string, number>;

export type LiveLogEntry =
	| { kind: "turn_start" }
	| { kind: "turn_end";   turn: number; inputTokens: number; outputTokens: number }
	| { kind: "tool_start"; toolName: string; args: Record<string, unknown> }
	| { kind: "tool_end";   toolName: string };

export const MAX_LIVE_LOG_ENTRIES = 6;

/** Result of a single subagent invocation. Live results include rich fields;
 * durable parent-session refs make those fields non-enumerable/omitted. */
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
	/** Cached final assistant text so durable details can omit full transcripts. */
	finalOutput?: string;
	/** Number of stderr characters omitted from the durable parent-session details. */
	stderrTruncatedChars?: number;
	/** Session directory used by this subagent process, when persisted. */
	sessionDir?: string;
	/** Child session id, when available. */
	sessionId?: string;
	/** Number of LLM turns completed so far in this agent run. */
	completedTurns: number;
	/** True while an LLM call is currently in flight (between turn_start and turn_end). */
	turnInProgress: boolean;
	/**
	 * Tools actively executing right now, keyed by toolCallId.
	 * Present only while at least one tool is running; entries are added on
	 * tool_execution_start and removed on tool_execution_end.
	 */
	liveToolExecutions?: Record<string, { toolName: string; args: Record<string, unknown> }>;
	/**
	 * Rolling buffer of the last MAX_LIVE_LOG_ENTRIES events for TUI display.
	 * Populated while the agent is running; each entry is one display line.
	 */
	liveLog: LiveLogEntry[];
	/**
	 * Transient, streaming progress for nested subagent calls made by this agent,
	 * keyed by the nested subagent toolCallId. This is intentionally not part of
	 * the durable conversation history; final nested results still live in
	 * messages as toolResult entries.
	 */
	liveNestedSubagents?: Record<string, SubagentDetails>;
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
	/** Durable schema marker. Present on persisted parent-session details. */
	schemaVersion?: 3;
	mode: "single" | "parallel";
	delegationMode: DelegationMode;
	projectAgentsDir: string | null;
	/** Direct child refs in durable details; richer results in live in-memory details. */
	results: SingleResult[];
	/** One aggregate recursive summary. Durable details store no per-agent usage. */
	usageSummary?: SubagentUsageSummary;
  /** Usage summed across all results and all their nested descendants (live/legacy only) */
  aggregatedUsage: UsageStats;
  /** Tool calls merged across all results and all their nested descendants (live/legacy only) */
  aggregatedToolCalls: ToolCallCounts;
  /** Per-agent recursive usage breakdown (live/legacy only; never durable) */
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
		const usage = r.usage ?? emptyUsage();
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
		total.turns += usage.turns;
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
  const messages = result.messages ?? [];
  const children: UsageTreeNode[] = [];
  for (const nested of getNestedSubagentResults(messages)) {
    for (const nestedResult of nested.details.results) {
      children.push(buildUsageTreeNode(nestedResult));
    }
  }

  const ownUsage = result.usage ?? emptyUsage();
  const ownToolCalls: ToolCallCounts = result.toolCalls ?? extractToolCalls(messages);

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
export function compactSingleResultForDurableDetails(result: SingleResult): SingleResult {
  const ref: any = {
    agent: result.agent,
    agentSource: result.agentSource,
    task: result.task,
    exitCode: result.exitCode,
    ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
    ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
    ...(result.sessionDir !== undefined ? { sessionDir: result.sessionDir } : {}),
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
  };
  // Compatibility for in-memory/unit-test consumers only. These properties are
  // deliberately non-enumerable so parent session JSON persists a pure ref.
  Object.defineProperties(ref, {
    messages: { value: [], enumerable: false },
    stderr: { value: "", enumerable: false },
    usage: { value: result.usage ?? emptyUsage(), enumerable: false },
    toolCalls: { value: {}, enumerable: false },
    model: { value: result.model, enumerable: false },
    finalOutput: { value: result.finalOutput ?? getFinalOutput(result.messages ?? []), enumerable: false },
    stderrTruncatedChars: { value: result.stderrTruncatedChars ?? Math.max(0, (result.stderr?.length ?? 0)), enumerable: false },
    completedTurns: { value: result.completedTurns, enumerable: false },
    turnInProgress: { value: result.turnInProgress, enumerable: false },
    liveLog: { value: [], enumerable: false },
    liveNestedSubagents: { value: undefined, enumerable: false },
  });
  return ref as SingleResult;
}

export function emptyUsageSummary(): SubagentUsageSummary {
  return {
    subagentCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

export function addUsageSummary(total: SubagentUsageSummary, delta: SubagentUsageSummary): void {
  total.subagentCount += delta.subagentCount;
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheReadTokens += delta.cacheReadTokens;
  total.cacheWriteTokens += delta.cacheWriteTokens;
  total.costUsd += delta.costUsd;
  total.turns += delta.turns;
}

export function usageSummaryFromUsage(usage: UsageStats | undefined): SubagentUsageSummary {
  return {
    subagentCount: 1,
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    cacheWriteTokens: usage?.cacheWrite ?? 0,
    costUsd: usage?.cost ?? 0,
    turns: usage?.turns ?? 0,
  };
}

export function buildUsageSummary(results: SingleResult[]): SubagentUsageSummary {
  const total = emptyUsageSummary();
  for (const result of results) {
    addUsageSummary(total, usageSummaryFromUsage(result.usage));
    for (const nested of getNestedSubagentResults(result.messages ?? [])) {
      addUsageSummary(total, nested.details.usageSummary ?? buildUsageSummary(nested.details.results));
    }
  }
  return total;
}

export function usageSummaryToUsageStats(summary: SubagentUsageSummary | undefined): UsageStats | undefined {
  if (!summary) return undefined;
  return {
    input: summary.inputTokens,
    output: summary.outputTokens,
    cacheRead: summary.cacheReadTokens,
    cacheWrite: summary.cacheWriteTokens,
    cost: summary.costUsd,
    contextTokens: 0,
    turns: summary.turns,
  };
}

function aggregateDetailsFromUsageTree(
  mode: "single" | "parallel",
  delegationMode: DelegationMode,
  projectAgentsDir: string | null,
  results: SingleResult[],
  usageTree: UsageTreeNode[],
  includeUsageTree: boolean,
): SubagentDetails {
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
    usageTree: includeUsageTree ? usageTree : [],
  };
}

export function buildLiveSubagentDetails(
  mode: "single" | "parallel",
  delegationMode: DelegationMode,
  projectAgentsDir: string | null,
  results: SingleResult[],
): SubagentDetails {
  return aggregateDetailsFromUsageTree(
    mode,
    delegationMode,
    projectAgentsDir,
    results,
    results.map(buildUsageTreeNode),
    true,
  );
}

export function buildSubagentDetails(
  mode: "single" | "parallel",
  delegationMode: DelegationMode,
  projectAgentsDir: string | null,
  results: SingleResult[],
): SubagentDetails {
  const durableResults = results.map(compactSingleResultForDurableDetails);
  const usageTree = results.map(buildUsageTreeNode);
  const details: any = {
    schemaVersion: 3,
    mode,
    delegationMode,
    projectAgentsDir,
    results: durableResults,
    usageSummary: buildUsageSummary(results),
  };
  // Compatibility for older render/tests. Non-enumerable so persisted JSON keeps
  // the schema-v3 durable shape: refs + usageSummary only.
  const aggregate = aggregateDetailsFromUsageTree(mode, delegationMode, projectAgentsDir, results, usageTree, true);
  Object.defineProperties(details, {
    aggregatedUsage: { value: aggregate.aggregatedUsage, enumerable: false },
    aggregatedToolCalls: { value: aggregate.aggregatedToolCalls, enumerable: false },
    usageTree: { value: [], enumerable: false },
  });
  return details as SubagentDetails;
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
		maybe.delegationMode === "spawn" &&
		Array.isArray(maybe.results);
}

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: Message[], fallback?: string): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const part = msg.content[j];
				if (part.type === "text") return part.text;
			}
		}
	}
	return fallback ?? "";
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
		const nested = getNestedSubagentResults(result.messages ?? []);
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
