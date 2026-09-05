import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const SUBAGENT_MAX_TOTAL_AGENTS_ENV = "PI_SUBAGENT_MAX_TOTAL_AGENTS";
export const SUBAGENT_BUDGET_DIR_ENV = "PI_SUBAGENT_BUDGET_DIR";
export const SUBAGENT_BUDGET_CUSTOM_TYPE = "pi-subagent-budget";
export const DEFAULT_MAX_TOTAL_AGENTS = 50;

export interface SubagentBudget {
  directory: string;
}

export interface BudgetTask {
  agent: string;
  task: string;
  max_agents_allowed: number;
}

interface Reservation {
  tasks: BudgetTask[];
  children: SubagentBudget[];
  /** High-water reservations after resume overrides. Original tasks stay replayable. */
  reservedSizes?: number[];
}

interface BudgetState {
  version: 4;
  /** Slots for new agents. The branch's existing worker is already paid for. */
  limit: number;
  remaining: number;
  reservations: Record<string, Reservation>;
}

export class SubagentBudgetError extends Error {}

export function isBudgetAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isBranchBudgetAmount(value: unknown): value is number {
  return isBudgetAmount(value) && value >= 1;
}

export function configuredTotalBudget(value = process.env[SUBAGENT_MAX_TOTAL_AGENTS_ENV]): number {
  if (value === undefined) return DEFAULT_MAX_TOTAL_AGENTS;
  if (!/^\d+$/.test(value.trim()) || !isBudgetAmount(Number(value))) {
    throw new SubagentBudgetError(`Invalid ${SUBAGENT_MAX_TOTAL_AGENTS_ENV}=${JSON.stringify(value)}. Use a non-negative safe integer. New launches are blocked until this is corrected.`);
  }
  return Number(value);
}

export function findPersistedBudget(entries: unknown): SubagentBudget | undefined {
  if (!Array.isArray(entries)) return undefined;
  const entry = [...entries].reverse().find((item) => item?.type === "custom" && item.customType === SUBAGENT_BUDGET_CUSTOM_TYPE);
  if (!entry) return undefined;
  if (typeof entry.data?.directory !== "string" || !path.isAbsolute(entry.data.directory)) {
    throw new SubagentBudgetError("Invalid saved subagent budget. Refusing to create a replacement allowance.");
  }
  return { directory: entry.data.directory };
}

function latestState(budget: SubagentBudget): { revision: number; state: BudgetState } {
  try {
    const revisions = fs.readdirSync(budget.directory)
      .map((name) => /^state-(\d+)\.json$/.exec(name))
      .filter((match) => match !== null)
      .map((match) => Number(match![1]));
    const revision = Math.max(...revisions);
    if (!isBudgetAmount(revision)) throw new Error("no committed budget state");
    const state = JSON.parse(fs.readFileSync(path.join(budget.directory, `state-${revision}.json`), "utf8"));
    if ((state?.version !== 1 && state?.version !== 2 && state?.version !== 3 && state?.version !== 4) || !isBudgetAmount(state.limit) || !isBudgetAmount(state.remaining) || state.remaining > state.limit || !state.reservations || typeof state.reservations !== "object" || Array.isArray(state.reservations)) {
      throw new Error("invalid budget state");
    }
    let allocated = 0;
    for (const reservation of Object.values(state.reservations) as Reservation[]) {
      if (!Array.isArray(reservation?.tasks) || !Array.isArray(reservation.children) || reservation.tasks.length !== reservation.children.length) {
        throw new Error("invalid reservation");
      }
      if (reservation.reservedSizes !== undefined && (!Array.isArray(reservation.reservedSizes) || reservation.reservedSizes.length !== reservation.tasks.length)) {
        throw new Error("invalid reserved sizes");
      }
      for (const [index, task] of reservation.tasks.entries()) {
        // Read old reservations without changing their grants or remaining slots.
        if (state.version < 3) {
          const legacy = state.version === 1 ? (task as any).max_subagents_allowed : (task as any).max_agents_in_branch;
          if (!isBudgetAmount(legacy)) throw new Error("invalid legacy child allowance");
          reservation.tasks[index] = { agent: task.agent, task: task.task, max_agents_allowed: state.version === 1 ? legacy + 1 : legacy };
        }
        const size = reservation.tasks[index].max_agents_allowed;
        if (!isBranchBudgetAmount(size) || typeof reservation.children[index]?.directory !== "string" || !path.isAbsolute(reservation.children[index].directory)) {
          throw new Error("invalid child allowance");
        }
        const reserved = reservation.reservedSizes?.[index] ?? size;
        if (!isBranchBudgetAmount(reserved) || reserved < size) throw new Error("invalid reserved size");
        allocated += reserved;
      }
    }
    if (!Number.isSafeInteger(allocated) || state.limit - allocated !== state.remaining) throw new Error("budget totals do not match reservations");
    state.version = 4;
    return { revision, state };
  } catch (error) {
    throw new SubagentBudgetError(`Cannot read subagent budget at ${budget.directory}: ${error instanceof Error ? error.message : error}. New launches are blocked; the allowance will not be reset.`);
  }
}

/**
 * Publish a complete immutable state using an atomic hard link. Concurrent
 * writers target the same next revision; only one wins, and the others retry
 * against its state. There are no locks to expire or steal from a live process.
 * Never delete old revisions: their existence prevents an ABA race.
 */
function commit(budget: SubagentBudget, revision: number, state: BudgetState): boolean {
  const temporaryDirectory = path.join(budget.directory, "tmp");
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const candidate = path.join(temporaryDirectory, `${process.pid}-${randomUUID()}.json`);
  const fd = fs.openSync(candidate, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(candidate, path.join(budget.directory, `state-${revision}.json`));
    return true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.unlinkSync(candidate);
  }
}

/** Only call for a new root or a child already reserved by its parent. */
export function createBudget(directory: string, limit: number): SubagentBudget {
  if (!isBudgetAmount(limit)) throw new SubagentBudgetError("Budget must be a non-negative safe integer.");
  const budget = { directory: path.resolve(directory) };
  commit(budget, 0, { version: 4, limit, remaining: limit, reservations: {} });
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
  return `${limit} Set max_agents_allowed on each task to include the assigned subagent and everyone it may launch. The number you choose is exactly the number of slots reserved. Use 1 for a direct worker. Unused slots stay reserved for that worker's future resumes. Resuming an existing subagent uses no slot. Its allowance stays unchanged unless you explicitly override it; an override never resets slots already spent. If no slots remain, do not launch new subagents.`;
}

export interface ResumeBudgetOverride {
  budget: SubagentBudget;
  max_agents_allowed: number;
}

function reservationForChild(state: BudgetState, child: SubagentBudget): { reservation: Reservation; index: number } {
  for (const reservation of Object.values(state.reservations)) {
    const index = reservation.children.findIndex((candidate) => candidate.directory === child.directory);
    if (index >= 0) return { reservation, index };
  }
  throw new SubagentBudgetError("This subagent has no recorded reservation to resize. Resume it without max_agents_allowed.");
}

function checkOverrideFloor(update: ResumeBudgetOverride): void {
  if (!isBranchBudgetAmount(update.max_agents_allowed)) {
    throw new SubagentBudgetError("Resume max_agents_allowed must be a positive safe integer, including the resumed subagent. Omit it to keep the current allowance.");
  }
  const { limit, remaining } = readBudget(update.budget);
  const minimum = limit - remaining + 1;
  if (update.max_agents_allowed < minimum) {
    throw new SubagentBudgetError(`Cannot set max_agents_allowed to ${update.max_agents_allowed}: this subagent already needs ${minimum} slots including itself and slots spent or reserved for its workers. Choose at least ${minimum}, or omit the override.`);
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
      throw new SubagentBudgetError("Cannot override a budget outside your own delegation tree. Resume this subagent without the override.");
    }
    if (path.basename(path.dirname(update.budget.directory)) !== "children") {
      throw new SubagentBudgetError("This subagent has no recorded reservation to resize. Resume it without max_agents_allowed.");
    }
    return { directory: path.dirname(path.dirname(update.budget.directory)) };
  });
  if (new Set(parents.map((parent) => parent.directory)).size !== 1) {
    throw new SubagentBudgetError("Budget overrides in one resume call must share the same original launcher. Split these overrides into separate calls. No budgets were changed.");
  }
  const parent = parents[0];
  for (;;) {
    const { revision, state } = latestState(parent);
    let extra = 0;
    for (const update of updates) {
      checkOverrideFloor(update);
      const { reservation, index } = reservationForChild(state, update.budget);
      const reserved = reservation.reservedSizes?.[index] ?? reservation.tasks[index].max_agents_allowed;
      extra += Math.max(0, update.max_agents_allowed - reserved);
      if (!Number.isSafeInteger(extra)) throw new SubagentBudgetError("Requested resume budget increase is too large.");
      reservation.reservedSizes ??= reservation.tasks.map((task) => task.max_agents_allowed);
      reservation.reservedSizes[index] = Math.max(reserved, update.max_agents_allowed);
    }
    if (extra > state.remaining) {
      const available = showRemainingBudget(state.remaining, audience)
        ? `The original launcher has ${state.remaining} unassigned slots.`
        : "This exceeds the original launcher's remaining allowance.";
      throw new SubagentBudgetError(`Resume budget increase needs ${extra} extra slots. ${available} Reduce or omit max_agents_allowed. No budgets were changed.`);
    }
    if (extra === 0 || commit(parent, revision + 1, { ...state, remaining: state.remaining - extra })) break;
  }
  for (const update of updates) {
    for (;;) {
      const { revision, state } = latestState(update.budget);
      const spent = state.limit - state.remaining;
      const limit = update.max_agents_allowed - 1;
      if (limit < spent) {
        throw new SubagentBudgetError("This subagent assigned more slots while its budget was being changed. Retry with a higher max_agents_allowed or omit the override. Any funded increases stay reserved.");
      }
      if (limit === state.limit || commit(update.budget, revision + 1, { ...state, limit, remaining: limit - spent })) break;
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
    if (!isBranchBudgetAmount(task.max_agents_allowed)) {
      throw new SubagentBudgetError(`tasks[${index}].max_agents_allowed is required and must be a positive safe integer. It includes the assigned subagent. Use 1 for a direct worker.`);
    }
    required += task.max_agents_allowed;
    if (!Number.isSafeInteger(required)) throw new SubagentBudgetError("Requested subagent budget is too large. Reduce the child allowances.");
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
        throw new SubagentBudgetError("This tool call already reserved a different budget. Use a new tool call for changed tasks or allowances.");
      }
      for (const child of existing.children) readBudget(child);
      return existing.children;
    }
    if (required > state.remaining) {
      const available = showRemainingBudget(state.remaining, audience)
        ? `Your branch has ${state.remaining} slots left.`
        : "This exceeds your remaining allowance.";
      throw new SubagentBudgetError(`Subagent budget exceeded: this call needs ${required} slots in total. ${available} Reduce the number of tasks or their max_agents_allowed values. Use 1 for direct workers. No agents were launched and no slots were reserved by this call.`);
    }
    const children = tasks.map((_task, index) => ({ directory: path.join(budget.directory, "children", `${key}-${index}`) }));
    const next: BudgetState = {
      ...state,
      remaining: state.remaining - required,
      reservations: { ...state.reservations, [key]: { tasks, children } },
    };
    // Prepare children before publishing the grant. They cannot run until the
    // parent commit succeeds. A crash here leaves only unused child ledgers.
    children.forEach((child, index) => {
      const remainingForChildren = tasks[index].max_agents_allowed - 1;
      createBudget(child.directory, remainingForChildren);
      if (readBudget(child).limit !== remainingForChildren) {
        throw new SubagentBudgetError("This tool call previously prepared a different child allowance. Use a new tool call.");
      }
    });
    if (commit(budget, revision + 1, next)) return children;
  }
}
