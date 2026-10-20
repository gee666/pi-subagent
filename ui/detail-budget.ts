import { readBudget, type SubagentBudget } from "../budget.js";

export interface DetailBudget {
  allowed: number;
  used: number;
  remaining: number;
}

/** Read only the selected agent's ledger, never walk its descendants. */
export function readDetailBudget(budget?: SubagentBudget): DetailBudget | undefined {
  if (!budget) return undefined;
  try {
    const { limit, remaining } = readBudget(budget);
    return { allowed: limit, used: limit - remaining, remaining };
  } catch {
    return undefined;
  }
}

export function detailBudgetLine(budget?: DetailBudget): string {
  return budget
    ? `Subagent budget: ${budget.allowed} allowed • ${budget.used} used/reserved • ${budget.remaining} remaining`
    : "Subagent budget: unknown";
}
