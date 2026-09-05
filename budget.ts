import * as path from "node:path";
import { createHash } from "node:crypto";

import { latestState, commit } from "./storage/budget-ledger.js";
import { isRecord } from "./storage/values.js";
import {
  isBudgetAmount,
  isBranchBudgetAmount,
  SubagentBudgetError,
  type SubagentBudget,
  type BudgetTask,
  type BudgetState,
  type Reservation,
} from "./storage/budget-state.js";
export {
  isBudgetAmount,
  isBranchBudgetAmount,
  SubagentBudgetError,
  type SubagentBudget,
  type BudgetTask,
} from "./storage/budget-state.js";

export const SUBAGENT_MAX_TOTAL_AGENTS_ENV = "PI_SUBAGENT_MAX_TOTAL_AGENTS";
export const SUBAGENT_BUDGET_DIR_ENV = "PI_SUBAGENT_BUDGET_DIR";
export const SUBAGENT_BUDGET_CUSTOM_TYPE = "pi-subagent-budget";
export const DEFAULT_MAX_TOTAL_AGENTS = 50;

export function configuredTotalBudget(value = process.env[SUBAGENT_MAX_TOTAL_AGENTS_ENV]): number {
  if (value === undefined) return DEFAULT_MAX_TOTAL_AGENTS;
  if (!/^\d+$/.test(value.trim()) || !isBudgetAmount(Number(value))) {
    throw new SubagentBudgetError(
      `Invalid ${SUBAGENT_MAX_TOTAL_AGENTS_ENV}=${JSON.stringify(value)}. Use a non-negative safe integer. New launches are blocked until this is corrected.`,
    );
  }
  return Number(value);
}

export function findPersistedBudget(entries: unknown): SubagentBudget | undefined {
  if (!Array.isArray(entries)) return undefined;
  const entry = [...entries]
    .reverse()
    .find(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === "custom" && item.customType === SUBAGENT_BUDGET_CUSTOM_TYPE,
    );
  if (!entry) return undefined;
  if (!isRecord(entry.data) || typeof entry.data.directory !== "string" || !path.isAbsolute(entry.data.directory)) {
    throw new SubagentBudgetError("Invalid saved subagent budget. Refusing to create a replacement allowance.");
  }
  return { directory: entry.data.directory };
}

/** Only call for a new root or a child already reserved by its parent. */
export function createBudget(directory: string, limit: number): SubagentBudget {
  if (!isBudgetAmount(limit)) throw new SubagentBudgetError("Budget must be a non-negative safe integer.");
  const budget = { directory: path.resolve(directory) };
  commit(budget, 0, { version: 5, limit, remaining: limit, reservations: {} });
  // Existing ledgers are never reset, even if configuration has changed.
  latestState(budget);
  return budget;
}

export function readBudget(budget: SubagentBudget): { limit: number; remaining: number } {
  const { state } = latestState(budget);
  return { limit: state.limit, remaining: state.remaining };
}

type BudgetAudience = "main" | "subagent";

function showRemainingBudget(remaining: number, audience: BudgetAudience): boolean {
  return audience !== "main" || remaining < 30;
}

export function budgetPrompt(budget: SubagentBudget, audience: BudgetAudience = "subagent"): string {
  const { remaining } = readBudget(budget);
  if (remaining === 0) return "You cannot launch subagents.";
  if (remaining === 1) return "You may launch one subagent and resume it as often as needed.";
  const limit = showRemainingBudget(remaining, audience)
    ? `You may launch at most ${remaining} more subagents, including all nested launches.`
    : "The total subagent allowance is enforced automatically.";
  return `${limit} Set max_subagents_allowed on each task to cap all descendants, excluding the assigned worker. Each task reserves one slot for the worker plus its descendant cap. Use 0 for a direct worker. Unused slots stay reserved for that worker's future resumes. Resuming an existing subagent uses no slot. Its allowance stays unchanged unless you explicitly override it; an override never resets slots already spent. If no slots remain, do not launch new subagents.`;
}

export interface ResumeBudgetOverride {
  budget: SubagentBudget;
  max_subagents_allowed: number;
}

function reservationForChild(state: BudgetState, child: SubagentBudget): { reservation: Reservation; index: number } {
  for (const reservation of Object.values(state.reservations)) {
    const index = reservation.children.findIndex((candidate) => candidate.directory === child.directory);
    if (index >= 0) return { reservation, index };
  }
  throw new SubagentBudgetError(
    "This subagent has no recorded reservation to resize. Resume it without max_subagents_allowed.",
  );
}

function checkOverrideFloor(update: ResumeBudgetOverride): void {
  if (!isBranchBudgetAmount(update.max_subagents_allowed)) {
    throw new SubagentBudgetError(
      "Resume max_subagents_allowed must be a non-negative safe integer below Number.MAX_SAFE_INTEGER, excluding the resumed subagent. Omit it to keep the current allowance.",
    );
  }
  const { limit, remaining } = readBudget(update.budget);
  const minimum = limit - remaining;
  if (update.max_subagents_allowed < minimum) {
    throw new SubagentBudgetError(
      `Cannot set max_subagents_allowed to ${update.max_subagents_allowed}: this subagent already needs ${minimum} descendant slots spent or reserved for its workers. Choose at least ${minimum}, or omit the override.`,
    );
  }
}

/**
 * Reserve increases in the original parent's ledger before expanding children.
 * Lowering an operating cap never refunds its reserved capacity. This avoids
 * cross-ledger transfers: a crash can leave capacity reserved but cannot mint
 * slots. Repeating an increase charges only above the previous high-water mark.
 */
export function overrideResumeBudgets(
  caller: SubagentBudget,
  updates: ResumeBudgetOverride[],
  audience: BudgetAudience = "subagent",
): void {
  if (!updates.length) return;
  if (new Set(updates.map((update) => update.budget.directory)).size !== updates.length) {
    throw new SubagentBudgetError("Cannot override the same subagent budget twice in one resume call.");
  }
  const parents = updates.map((update) => {
    checkOverrideFloor(update);
    const relative = path.relative(caller.directory, update.budget.directory);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new SubagentBudgetError(
        "Cannot override a budget outside your own delegation tree. Resume this subagent without the override.",
      );
    }
    if (path.basename(path.dirname(update.budget.directory)) !== "children") {
      throw new SubagentBudgetError(
        "This subagent has no recorded reservation to resize. Resume it without max_subagents_allowed.",
      );
    }
    return { directory: path.dirname(path.dirname(update.budget.directory)) };
  });
  if (new Set(parents.map((parent) => parent.directory)).size !== 1) {
    throw new SubagentBudgetError(
      "Budget overrides in one resume call must share the same original launcher. Split these overrides into separate calls. No budgets were changed.",
    );
  }
  const parent = parents[0];
  for (;;) {
    const { revision, state } = latestState(parent);
    let extra = 0;
    for (const update of updates) {
      checkOverrideFloor(update);
      const { reservation, index } = reservationForChild(state, update.budget);
      const reserved = reservation.reservedSizes?.[index] ?? reservation.tasks[index].max_subagents_allowed + 1;
      const requested = update.max_subagents_allowed + 1;
      extra += Math.max(0, requested - reserved);
      if (!Number.isSafeInteger(extra)) throw new SubagentBudgetError("Requested resume budget increase is too large.");
      reservation.reservedSizes ??= reservation.tasks.map((task) => task.max_subagents_allowed + 1);
      reservation.reservedSizes[index] = Math.max(reserved, requested);
    }
    if (extra > state.remaining) {
      const available = showRemainingBudget(state.remaining, audience)
        ? `The original launcher has ${state.remaining} unassigned slots.`
        : "This exceeds the original launcher's remaining allowance.";
      throw new SubagentBudgetError(
        `Resume budget increase needs ${extra} extra slots. ${available} Reduce or omit max_subagents_allowed. No budgets were changed.`,
      );
    }
    if (extra === 0 || commit(parent, revision + 1, { ...state, remaining: state.remaining - extra })) break;
  }
  for (const update of updates) {
    for (;;) {
      const { revision, state } = latestState(update.budget);
      const spent = state.limit - state.remaining;
      const limit = update.max_subagents_allowed;
      if (limit < spent) {
        throw new SubagentBudgetError(
          "This subagent assigned more slots while its budget was being changed. Retry with a higher max_subagents_allowed or omit the override. Any funded increases stay reserved.",
        );
      }
      if (limit === state.limit || commit(update.budget, revision + 1, { ...state, limit, remaining: limit - spent }))
        break;
    }
  }
}

/** Reserve the whole batch before any child starts. Failed requests change nothing. */
export function reserveSubagentBudgets(
  budget: SubagentBudget,
  callId: string,
  tasks: BudgetTask[],
  audience: BudgetAudience = "subagent",
): SubagentBudget[] {
  let required = 0;
  for (const [index, task] of tasks.entries()) {
    if (!isBranchBudgetAmount(task.max_subagents_allowed)) {
      throw new SubagentBudgetError(
        `tasks[${index}].max_subagents_allowed is required and must be a non-negative safe integer below Number.MAX_SAFE_INTEGER. It excludes the assigned subagent. Use 0 for a direct worker.`,
      );
    }
    required += 1 + task.max_subagents_allowed;
    if (!Number.isSafeInteger(required))
      throw new SubagentBudgetError("Requested subagent budget is too large. Reduce the child allowances.");
  }
  if (!tasks.length) return [];
  const key = createHash("sha256").update(callId).digest("hex");
  // A successful commit consumes at least one slot, so competing writers
  // cannot keep retrying forever within a finite allowance.
  for (;;) {
    const { revision, state } = latestState(budget);
    const existing = state.reservations[key];
    if (existing) {
      if (JSON.stringify(existing.tasks) !== JSON.stringify(tasks)) {
        throw new SubagentBudgetError(
          "This tool call already reserved a different budget. Use a new tool call for changed tasks or allowances.",
        );
      }
      for (const child of existing.children) readBudget(child);
      return existing.children;
    }
    if (required > state.remaining) {
      const available = showRemainingBudget(state.remaining, audience)
        ? `Your branch has ${state.remaining} slots left.`
        : "This exceeds your remaining allowance.";
      throw new SubagentBudgetError(
        `Subagent budget exceeded: this call needs ${required} slots in total. ${available} Reduce the number of tasks or their max_subagents_allowed values. Use 0 for direct workers. No agents were launched and no slots were reserved by this call.`,
      );
    }
    const children = tasks.map((_task, index) => ({
      directory: path.join(budget.directory, "children", `${key}-${index}`),
    }));
    const next: BudgetState = {
      ...state,
      remaining: state.remaining - required,
      reservations: { ...state.reservations, [key]: { tasks, children } },
    };
    // Prepare children before publishing the grant. They cannot run until the
    // parent commit succeeds. A crash here leaves only unused child ledgers.
    children.forEach((child, index) => {
      const remainingForChildren = tasks[index].max_subagents_allowed;
      createBudget(child.directory, remainingForChildren);
      if (readBudget(child).limit !== remainingForChildren) {
        throw new SubagentBudgetError(
          "This tool call previously prepared a different child allowance. Use a new tool call.",
        );
      }
    });
    if (commit(budget, revision + 1, next)) return children;
  }
}
