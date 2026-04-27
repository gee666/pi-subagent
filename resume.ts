import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isResultError, isSubagentDetails, type SingleResult, type SubagentDetails } from "./types.js";

export const SUBAGENT_RESUME_PROMPT_ENV = "PI_SUBAGENT_RESUME_PROMPT";
export const SUBAGENT_RESUME_DISABLE_ENV = "PI_SUBAGENT_DISABLE_RESUME";
export const SUBAGENT_SESSION_ROOT_ENV = "PI_SUBAGENT_SESSION_ROOT";

type SessionEntry = ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number];

export interface ResumableSubagentCall {
  previousToolCallId: string;
  tasks: Array<{ agent: string; task: string; cwd?: string }>;
  details?: SubagentDetails;
}

export function parseBooleanEnv(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

export function getDefaultSubagentSessionRoot(ctx: ExtensionContext): string {
  const inheritedRoot = process.env[SUBAGENT_SESSION_ROOT_ENV];
  if (inheritedRoot) return inheritedRoot;

  const mainSessionDir = ctx.sessionManager.getSessionDir?.();
  if (typeof mainSessionDir === "string" && mainSessionDir.length > 0) {
    return path.join(path.dirname(mainSessionDir), "sessions-subagents");
  }
  return path.join(os.homedir(), ".pi", "agent", "sessions-subagents");
}

export function buildSubagentSessionDir(
  root: string,
  parentSessionId: string,
  toolCallId: string,
  index: number,
): string {
  const safeParent = parentSessionId.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  const safeTool = toolCallId.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return path.join(root, safeParent, safeTool, String(index));
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function branchEntries(ctx: ExtensionContext): SessionEntry[] {
  const leafId = ctx.sessionManager.getLeafId?.();
  if (leafId) {
    const branch = ctx.sessionManager.getBranch?.(leafId);
    if (Array.isArray(branch)) return branch as SessionEntry[];
  }
  const entries = ctx.sessionManager.getEntries?.();
  return Array.isArray(entries) ? entries as SessionEntry[] : [];
}

function getSubagentToolCalls(message: any): Array<{ id: string; args: any }> {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const calls: Array<{ id: string; args: any }> = [];
  for (const part of message.content) {
    if (part?.type === "toolCall" && part.name === "subagent" && typeof part.id === "string") {
      calls.push({ id: part.id, args: part.arguments });
    }
  }
  return calls;
}

function normalizeTasks(args: any): Array<{ agent: string; task: string; cwd?: string }> | null {
  const rawTasks = args?.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) return null;
  const tasks: Array<{ agent: string; task: string; cwd?: string }> = [];
  for (const task of rawTasks) {
    if (typeof task?.agent !== "string" || typeof task?.task !== "string") return null;
    tasks.push({
      agent: task.agent,
      task: task.task,
      ...(typeof task.cwd === "string" ? { cwd: task.cwd } : {}),
    });
  }
  return tasks;
}

function hasUnfinishedResults(details: SubagentDetails | undefined): boolean {
  if (!details) return true;
  return details.results.some((result) => result.exitCode === -1 || isResultError(result));
}

function messageHasNonEmptyText(message: any): boolean {
  const content = message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
}

function messageHasToolCall(message: any): boolean {
  return Array.isArray(message?.content) && message.content.some((part: any) => part?.type === "toolCall");
}

function isIgnorableTrailingAbortMessage(entry: any): boolean {
  if (entry?.type !== "message") return true;
  const message = entry.message;
  if (!message) return true;

  // Pi may append a final aborted/error assistant message after it has already
  // closed an interrupted tool with a synthetic toolResult. That message is not
  // user-visible progress after the subagent activity, so it must not prevent
  // resume detection.
  if (
    message.role === "assistant" &&
    (message.stopReason === "aborted" || message.stopReason === "error") &&
    !messageHasNonEmptyText(message) &&
    !messageHasToolCall(message)
  ) {
    return true;
  }

  return false;
}

function hasOnlyIgnorableTrailingEntries(entries: SessionEntry[], activityOrder: number): boolean {
  for (let i = activityOrder + 1; i < entries.length; i++) {
    if (!isIgnorableTrailingAbortMessage(entries[i])) return false;
  }
  return true;
}

export function findLatestResumableSubagentCall(ctx: ExtensionContext): ResumableSubagentCall | null {
  const entries = branchEntries(ctx);
  const calls = new Map<string, { tasks: Array<{ agent: string; task: string; cwd?: string }>; order: number }>();
  const results = new Map<string, { details?: SubagentDetails; isError: boolean; order: number }>();

  entries.forEach((entry: any, order) => {
    if (entry?.type !== "message") return;
    const msg = entry.message;
    for (const call of getSubagentToolCalls(msg)) {
      const tasks = normalizeTasks(call.args);
      if (tasks) calls.set(call.id, { tasks, order });
    }
    if (msg?.role === "toolResult" && msg.toolName === "subagent" && typeof msg.toolCallId === "string") {
      results.set(msg.toolCallId, {
        details: isSubagentDetails(msg.details) ? msg.details : undefined,
        isError: msg.isError === true,
        order,
      });
    }
  });

  const candidates: Array<ResumableSubagentCall & { activityOrder: number }> = [];
  for (const [toolCallId, call] of calls) {
    const result = results.get(toolCallId);
    const unfinished = !result || result.isError || hasUnfinishedResults(result.details);
    if (!unfinished) continue;
    candidates.push({
      previousToolCallId: toolCallId,
      tasks: call.tasks,
      details: result?.details,
      activityOrder: result?.order ?? call.order,
    });
  }

  const latest = candidates.at(-1);
  if (!latest || !hasOnlyIgnorableTrailingEntries(entries, latest.activityOrder)) return null;
  return latest;
}

export function sameTasks(
  a: Array<{ agent: string; task: string; cwd?: string }>,
  b: Array<{ agent: string; task: string; cwd?: string }>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isFinishedResult(result: SingleResult | undefined): boolean {
  return !!result && result.exitCode === 0 && !isResultError(result);
}
