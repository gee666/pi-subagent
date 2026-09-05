/**
 * Shared type definitions for the subagent extension.
 */

import type { TranscriptMessage } from "./transcript.js";

/** Current tool names. "subagent" is the legacy launch tool name kept for old sessions. */
export const SUBAGENT_TOOL_NAME = "subagents";
export const RESUME_SUBAGENTS_TOOL_NAME = "resume_subagents";

/** Matches the launch tool, current or legacy ("subagents" / "subagent"). */
export function isSubagentLaunchToolName(name: unknown): boolean {
  return name === SUBAGENT_TOOL_NAME || name === "subagent";
}

/** Matches any delegation tool: launch (current or legacy) or resume. */
export function isSubagentToolName(name: unknown): boolean {
  return isSubagentLaunchToolName(name) || name === RESUME_SUBAGENTS_TOOL_NAME;
}

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
  /** Stable identities allow resumes to add usage without adding agents. */
  subagentIds?: string[];
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
  | { kind: "turn_start"; at?: number }
  | { kind: "turn_end"; turn: number; inputTokens: number; outputTokens: number; at?: number }
  | { kind: "tool_start"; toolName: string; args: Record<string, unknown>; at?: number }
  | { kind: "tool_end"; toolName: string; at?: number };

export const MAX_LIVE_LOG_ENTRIES = 6;

/** Result of a single subagent invocation. Live results include rich fields;
 * durable parent-session refs retain the compact completion/outcome fields needed
 * for crash-resume while omitting full transcripts and live-only state. */
export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "builtin" | "unknown";
  task: string;
  /** Unique resumable human name within the delegation tree (e.g. "John"). */
  name?: string;
  /** Durable branch allowance, shared by this agent's resumes and session forks. */
  budget?: import("../budget.js").SubagentBudget;
  /** Epoch ms when this subagent run started (used for TUI timestamps). */
  startedAt?: number;
  /** Most recent semantic activity in this agent's entire live run. */
  lastActionAt?: number;
  exitCode: number;
  messages: TranscriptMessage[];
  stderr: string;
  usage: UsageStats;
  toolCalls: ToolCallCounts;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Cached final assistant text so durable details can omit full transcripts. */
  finalOutput?: string;
  /** Own + descendant usage retained when full nested transcripts are omitted. */
  subtreeUsageSummary?: SubagentUsageSummary;
  /** Live resume baseline for pre-crash descendants whose transcripts were compacted. */
  priorDescendantUsageSummary?: SubagentUsageSummary;
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
  { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };
