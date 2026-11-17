import * as path from "node:path";
import {
  createBudget,
  reservedSubagentBudgets,
  reserveSubagentBudgets,
  type BudgetTask,
  type SubagentBudget,
} from "../budget.js";
import { getTaskBranchSize, type ResumableSubagentCall } from "../resume.js";
import { ensureBudget } from "./runtime.js";
import type { ExtensionState } from "./state.js";

interface RunnableTask {
  index: number;
  task: BudgetTask;
}

function sameBudgetTask(a: BudgetTask, b: BudgetTask): boolean {
  return a.agent === b.agent && a.task === b.task && a.max_subagents_allowed === b.max_subagents_allowed;
}

/**
 * Branch grants for runnable tasks, aligned with the call's task list.
 *
 * A recovery plan may hold only the interrupted subset of its launch, so it
 * never re-reserves under the original call: that would either conflict with
 * the full reservation or charge the branch twice. Each worker keeps its
 * recorded grant, falls back to its child in the original reservation, and
 * otherwise gets no descendant allowance.
 */
export function launchBudgets(
  state: ExtensionState,
  toolCallId: string,
  taskCount: number,
  runnable: RunnableTask[],
  plan: ResumableSubagentCall | null,
  sessionDirFor: (index: number) => string,
): Array<SubagentBudget | undefined> {
  const budgets: Array<SubagentBudget | undefined> = Array.from({ length: taskCount }, () => undefined);
  const audience = state.currentDepth === 0 ? "main" : "subagent";
  if (!plan) {
    const reserved = reserveSubagentBudgets(
      ensureBudget(state),
      toolCallId,
      runnable.map(({ task }) => task),
      audience,
    );
    runnable.forEach(({ index }, position) => (budgets[index] = reserved[position]));
    return budgets;
  }

  for (const { index } of runnable) budgets[index] = plan.details?.results[index]?.budget;
  const missing = runnable.filter(({ index }) => !budgets[index]);
  if (!missing.length) return budgets;
  const zeroAllowance = (index: number) => createBudget(path.join(sessionDirFor(index), "legacy-budget"), 0);
  // Legacy launches recorded no allowance to grant again.
  if (plan.tasks.every((task) => getTaskBranchSize(task) === undefined)) {
    for (const { index } of missing) budgets[index] = zeroAllowance(index);
    return budgets;
  }
  const original = reservedSubagentBudgets(ensureBudget(state), plan.previousToolCallId);
  if (!original) {
    // The launch was interrupted before it reserved anything.
    const reserved = reserveSubagentBudgets(
      ensureBudget(state),
      plan.previousToolCallId,
      missing.map(({ task }) => task),
      audience,
    );
    missing.forEach(({ index }, position) => (budgets[index] = reserved[position]));
    return budgets;
  }
  const claimed = new Set(budgets.map((budget) => budget?.directory));
  for (const { index, task } of missing) {
    const position = original.tasks.findIndex(
      (reservedTask, candidate) =>
        sameBudgetTask(reservedTask, task) && !claimed.has(original.children[candidate]?.directory),
    );
    const child = original.children[position];
    budgets[index] = child ?? zeroAllowance(index);
    if (child) claimed.add(child.directory);
  }
  return budgets;
}
