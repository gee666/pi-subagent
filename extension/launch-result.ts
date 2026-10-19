import { emptyUsage, type SingleResult } from "../types.js";
import type { SubagentBudget } from "../budget.js";

/** Durable launch receipt. Individual completions replace these unfinished refs. */
export function startedResult(
  task: { agent: string; task: string },
  name: string | undefined,
  budget: SubagentBudget | undefined,
  sessionDir: string,
): SingleResult {
  return {
    agent: task.agent,
    task: task.task,
    name,
    budget,
    sessionDir,
    agentSource: "unknown",
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
