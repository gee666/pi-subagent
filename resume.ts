import * as path from "node:path";
import { DEFAULT_AGENT } from "./agents.js";
import { excludeStoppedWorkers } from "./storage/stopped-workers.js";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseBoolean } from "./shared.js";
import { isBudgetAmount } from "./budget.js";
import { isRecord, sanitizePathComponent } from "./storage/values.js";
import { hasOnlyIgnorableTrailingEntries } from "./resume-tail.js";
import { findPendingAsyncPlans, type AsyncLaunch } from "./resume-slots.js";
import { formatSubagentLabel } from "./ui/agent-label.js";
import {
  asyncJobId,
  emptyUsage,
  isResultError,
  isSubagentDetails,
  isSubagentLaunchToolName,
  type SingleResult,
  type SubagentDetails,
} from "./types.js";

export const SUBAGENT_RESUME_DISABLE_ENV = "PI_SUBAGENT_DISABLE_RESUME";
export const SUBAGENT_SESSION_ROOT_ENV = "PI_SUBAGENT_SESSION_ROOT";
type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];
export interface ResumableTask {
  agent: string;
  task: string;
  intelligence?: string;
  /** Lifetime descendant cap, excluding the assigned worker. */
  max_subagents_allowed?: number;
  /** Read-only compatibility for recorded inclusive allowances. */
  max_agents_allowed?: number;
  max_agents_in_branch?: number;
}

export function getTaskBranchSize(task: ResumableTask): number | undefined {
  if (task.max_agents_allowed !== undefined) return task.max_agents_allowed;
  if (task.max_agents_in_branch !== undefined) return task.max_agents_in_branch;
  if (task.max_subagents_allowed === undefined) return undefined;
  return isBudgetAmount(task.max_subagents_allowed) ? task.max_subagents_allowed + 1 : NaN;
}

export interface ResumableSubagentCall {
  previousToolCallId: string;
  /** Only the interrupted tasks of the launch, aligned with `details.results`. */
  tasks: ResumableTask[];
  /** Launch index of each task, which keys its default session directory. Omitted when identical. */
  taskIndexes?: number[];
  details?: SubagentDetails;
}

export const parseBooleanEnv = parseBoolean;

export function getDefaultSubagentSessionRoot(ctx: ExtensionContext): string {
  const inheritedRoot = process.env[SUBAGENT_SESSION_ROOT_ENV];
  if (inheritedRoot) return inheritedRoot;

  const mainSessionDir = ctx.sessionManager.getSessionDir?.();
  if (typeof mainSessionDir === "string" && mainSessionDir.length > 0) {
    return path.join(mainSessionDir, "subagents");
  }

  return path.join(getAgentDir(), "sessions", "subagents");
}

export function buildSubagentSessionDir(
  root: string,
  parentSessionId: string,
  toolCallId: string,
  index: number,
): string {
  const safeParent = sanitizePathComponent(parentSessionId);
  const safeTool = sanitizePathComponent(toolCallId);
  return path.join(root, safeParent, safeTool, String(index));
}

export function branchEntries(ctx: ExtensionContext): SessionEntry[] {
  const leafId = ctx.sessionManager.getLeafId?.();
  if (leafId) {
    const branch = ctx.sessionManager.getBranch?.(leafId);
    if (Array.isArray(branch)) return branch;
  }
  const entries = ctx.sessionManager.getEntries?.();
  return Array.isArray(entries) ? entries : [];
}

// NOTE: crash-resume (the synthetic provider re-issuing unfinished subagent
// tool calls at startup) deliberately covers only the `subagent` tool. An
// interrupted `resume_subagents` call is NOT auto-resumed: replaying it would
// require re-resolving names through the registry mid-injection, and the named
// subagents can simply be resumed again by the model with another
// resume_subagents call once the session continues.
function getSubagentToolCalls(message: unknown): Array<{ id: string; args: unknown }> {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: Array<{ id: string; args: unknown }> = [];
  for (const part of message.content) {
    if (!isRecord(part) || part.type !== "toolCall" || !isSubagentLaunchToolName(part.name)) continue;
    const id =
      typeof part.id === "string" ? part.id : typeof part.toolCallId === "string" ? part.toolCallId : undefined;
    if (id) calls.push({ id, args: part.arguments });
  }
  return calls;
}

function normalizeTasks(args: unknown): ResumableTask[] | null {
  const rawTasks = isRecord(args) ? args.tasks : undefined;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) return null;
  const tasks: ResumableTask[] = [];
  for (const task of rawTasks) {
    if (
      !isRecord(task) ||
      (task.agent !== undefined && typeof task.agent !== "string") ||
      typeof task.task !== "string"
    )
      return null;
    const agent = task.agent ?? DEFAULT_AGENT.name;
    const intelligence = task.intelligence ?? undefined;
    if (intelligence !== undefined && typeof intelligence !== "string") return null;
    const normalized: ResumableTask = {
      agent,
      task: task.task,
      intelligence,
    };
    for (const field of ["max_agents_allowed", "max_agents_in_branch", "max_subagents_allowed"] as const) {
      if (task[field] !== undefined) normalized[field] = typeof task[field] === "number" ? task[field] : NaN;
    }
    const size = getTaskBranchSize(normalized);
    tasks.push({
      agent,
      task: task.task,
      ...(normalized.intelligence !== undefined ? { intelligence: normalized.intelligence } : {}),
      ...(size !== undefined ? { max_subagents_allowed: size - 1 } : {}),
    });
  }
  return tasks;
}

/** What a synchronous launch's tool result proves about its workers. */
type LegacyOutcome = SubagentDetails | "interrupted" | "rejected";

// Pi closes a tool call it aborted with exactly this error result.
function isPiAbortedToolResult(message: { isError?: unknown; content?: unknown }): boolean {
  const content = message.content;
  return (
    message.isError === true &&
    Array.isArray(content) &&
    content.length === 1 &&
    isRecord(content[0]) &&
    content[0].text === "Operation aborted"
  );
}

/**
 * Task indexes of a synchronous launch that were interrupted rather than
 * settled. A missing tool result or Pi's abort result means every task was cut
 * off; otherwise only missing and aborted runs were. Failures are final, and a
 * result without workers means the launch itself was rejected.
 */
function interruptedLegacyIndexes(outcome: LegacyOutcome | undefined, taskCount: number): number[] {
  const indexes = Array.from({ length: taskCount }, (_task, index) => index);
  if (outcome === undefined || outcome === "interrupted") return indexes;
  if (outcome === "rejected" || outcome.results.length === 0) return [];
  return indexes.filter((index) => {
    const result = outcome.results[index];
    return !result || result.exitCode === -1 || result.stopReason === "aborted";
  });
}

/** A never-started task, so recovered results stay aligned with recovered tasks. */
function unstartedResult(task: ResumableTask): SingleResult {
  return {
    agent: task.agent,
    agentSource: "unknown",
    task: task.task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    toolCalls: {},
    completedTurns: 0,
    turnInProgress: false,
    liveLog: [],
  };
}

function legacyPlan(
  previousToolCallId: string,
  tasks: ResumableTask[],
  outcome: LegacyOutcome | undefined,
  pending: number[],
): ResumableSubagentCall {
  const details = typeof outcome === "object" ? outcome : undefined;
  return {
    previousToolCallId,
    tasks: pending.map((index) => tasks[index]),
    taskIndexes: pending,
    details: details && {
      ...details,
      results: pending.map((index) => details.results[index] ?? unstartedResult(tasks[index])),
    },
  };
}

/** Workers interrupted when the session ended, grouped by their original launch call. */
export function findLatestResumableSubagentCalls(ctx: ExtensionContext): ResumableSubagentCall[] {
  const entries = branchEntries(ctx);
  const calls = new Map<string, { tasks: ResumableTask[]; order: number }>();
  const results = new Map<string, { outcome: LegacyOutcome; order: number }>();
  const launches: AsyncLaunch[] = [];

  entries.forEach((entry, order) => {
    if (entry?.type !== "message") return;
    const msg = entry.message;
    for (const call of getSubagentToolCalls(msg)) {
      const tasks = normalizeTasks(call.args);
      if (tasks) calls.set(call.id, { tasks, order });
    }
    if (msg?.role !== "toolResult" || !isSubagentLaunchToolName(msg.toolName) || typeof msg.toolCallId !== "string")
      return;
    const details = isSubagentDetails(msg.details) ? msg.details : undefined;
    const tasks = calls.get(msg.toolCallId)?.tasks;
    if (details && asyncJobId(details) && tasks) launches.push({ toolCallId: msg.toolCallId, tasks, details, order });
    else
      results.set(msg.toolCallId, {
        outcome: details ?? (isPiAbortedToolResult(msg) ? "interrupted" : "rejected"),
        order,
      });
  });

  const asyncLaunchIds = new Set(launches.map((launch) => launch.toolCallId));
  const candidates: Array<{ id: string; pending: number[]; callOrder: number; activityOrder: number }> = [];
  for (const [id, call] of calls) {
    if (asyncLaunchIds.has(id)) continue;
    const result = results.get(id);
    const pending = interruptedLegacyIndexes(result?.outcome, call.tasks.length);
    if (pending.length > 0)
      candidates.push({ id, pending, callOrder: call.order, activityOrder: result?.order ?? call.order });
  }
  const asyncPlans = findPendingAsyncPlans(entries, launches);
  const latest = candidates.sort((a, b) => a.activityOrder - b.activityOrder).at(-1);
  if (!latest) return excludeStoppedWorkers(asyncPlans, entries, calls);

  // One assistant message may issue several synchronous launch calls. Recover
  // every interrupted sibling together, or the others are abandoned.
  const batch = candidates.filter((candidate) => candidate.callOrder === latest.callOrder);
  const siblingResultOrders = Array.from(calls.entries())
    .filter(([, call]) => call.order === latest.callOrder)
    .map(([toolCallId]) => results.get(toolCallId)?.order)
    .filter((order): order is number => typeof order === "number");
  const latestBatchActivity = Math.max(
    latest.callOrder,
    ...batch.map((candidate) => candidate.activityOrder),
    ...siblingResultOrders,
  );
  if (!hasOnlyIgnorableTrailingEntries(entries, latestBatchActivity))
    return excludeStoppedWorkers(asyncPlans, entries, calls);

  const legacyPlans = batch.map(({ id, pending }) =>
    legacyPlan(id, calls.get(id)?.tasks ?? [], results.get(id)?.outcome, pending),
  );
  return excludeStoppedWorkers([...asyncPlans, ...legacyPlans], entries, calls);
}

/** Display labels of every worker a recovery would restart, in plan order. */
export function recoveryWorkerLabels(plans: ResumableSubagentCall[]): string[] {
  return plans.flatMap((plan) =>
    plan.tasks.map((task, index) => formatSubagentLabel(plan.details?.results[index] ?? task)),
  );
}

export function findLatestResumableSubagentCall(ctx: ExtensionContext): ResumableSubagentCall | null {
  return findLatestResumableSubagentCalls(ctx).at(-1) ?? null;
}
export function sameTasks(a: ResumableTask[], b: ResumableTask[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((task, index) => {
    const other = b[index];
    return (
      task.agent === other.agent &&
      task.task === other.task &&
      task.intelligence === other.intelligence &&
      (getTaskBranchSize(task) ?? 1) === (getTaskBranchSize(other) ?? 1)
    );
  });
}
export function isFinishedResult(result: SingleResult | undefined): boolean {
  return !!result && result.exitCode === 0 && !isResultError(result);
}
