import { emptyUsage, type SingleResult } from "../types.js";
import type { SubagentBudget } from "../budget.js";
import type { DetailsFactory } from "../runner/options.js";
import type { WorkerStatus } from "./scheduler.js";

export function launchReceipt(
  tasks: Array<{ agent: string; task: string }>,
  names: Array<string | undefined>,
  budgets: Array<SubagentBudget | undefined>,
  admissions: Array<WorkerStatus | "completed">,
  getSessionDir: (index: number) => string,
  getIntelligence: (index: number) => string | undefined,
  makeDetails: DetailsFactory,
  jobId: string,
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${admissions.filter((status) => status === "started").length} started, ${admissions.filter((status) => status === "queued").length} queued: ${tasks.map((task, index) => `${names[index] || task.agent || "worker"} (${admissions[index]})`).join(", ")}. Completion messages will arrive asynchronously. Keep working in parallel.`,
      },
    ],
    details: Object.assign(
      makeDetails(
        tasks.map((task, index) =>
          Object.assign(
            startedResult(task, names[index], budgets[index], getSessionDir(index), getIntelligence(index)),
            { executionStatus: admissions[index], queued: admissions[index] === "queued" },
          ),
        ),
      ),
      {
        asyncJobId: jobId,
        admissions: tasks.map((task, index) => ({ name: names[index], agent: task.agent, status: admissions[index] })),
      },
    ),
  };
}

/** Durable launch receipt. Individual completions replace these unfinished refs. */
export function startedResult(
  task: { agent: string; task: string },
  name: string | undefined,
  budget: SubagentBudget | undefined,
  sessionDir: string,
  intelligence?: string,
): SingleResult {
  return {
    agent: task.agent,
    task: task.task,
    name,
    intelligence,
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
