export interface SubagentBudget {
  directory: string;
}

export interface BudgetTask {
  agent: string;
  task: string;
  max_agents_allowed: number;
}

export interface Reservation {
  tasks: BudgetTask[];
  children: SubagentBudget[];
  /** High-water reservations after resume overrides. Original tasks stay replayable. */
  reservedSizes?: number[];
}

export interface BudgetState {
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
