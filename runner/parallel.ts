import type { AgentConfig } from "../agents.js";
import { type SingleResult, type SubagentDetails, emptyUsage, isResultSuccess, getFinalOutput } from "../types.js";
import type { SubagentBudget } from "../budget.js";
import {
  DEFAULT_MAX_PARALLEL_TASKS,
  DEFAULT_MAX_CONCURRENCY,
  PARALLEL_HEARTBEAT_MS,
  SUBAGENT_MAX_PARALLEL_TASKS_ENV,
  SUBAGENT_MAX_CONCURRENCY_ENV,
  mapConcurrent,
} from "../shared.js";
import type { DetailsFactory, OnUpdateCallback, RunningSubagentHandle } from "./options.js";
import { configuredNonNegativeInt } from "./constants.js";
import { sessionDirExists } from "./files.js";
import { runAgentSubprocess } from "./single.js";
export async function executeParallelSubprocess(
  tasks: Array<{ agent: string; task: string }>,
  agents: AgentConfig[],
  defaultCwd: string,
  parentDepth: number,
  maxDepth: number,
  parentAgentStack: string[],
  preventCycles: boolean,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: DetailsFactory,
  resumeResults?: SingleResult[],
  getSessionDir?: (index: number, task: { agent: string; task: string }) => string | undefined,
  resumeExistingSessions = false,
  sessionRoot?: string,
  fallbackModel?: string,
  onHandleForTask?: (index: number, task: { agent: string; task: string }, handle: RunningSubagentHandle) => void,
  onTaskDone?: (index: number, task: { agent: string; task: string }) => void,
  extras?: {
    /** Per-task resumable names (aligned with tasks by index). */
    names?: Array<string | undefined>;
    /** Send each task text to the child verbatim (resume_subagents flow). */
    rawPrompts?: boolean;
    /** Shared name-registry file passed to children via spawn env. */
    namesFile?: string;
    budgets?: Array<SubagentBudget | undefined>;
  },
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
  isError?: boolean;
}> {
  const maxParallelTasks = configuredNonNegativeInt(SUBAGENT_MAX_PARALLEL_TASKS_ENV, DEFAULT_MAX_PARALLEL_TASKS, true);
  const maxConcurrency = configuredNonNegativeInt(SUBAGENT_MAX_CONCURRENCY_ENV, DEFAULT_MAX_CONCURRENCY, true);

  if (tasks.length > maxParallelTasks) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Too many parallel tasks (${tasks.length}). Max is ${maxParallelTasks}.`,
        },
      ],
      details: makeDetails([]),
      isError: true,
    };
  }

  const allResults: SingleResult[] = tasks.map(
    (t, index) =>
      resumeResults?.[index] ?? {
        agent: t.agent,
        agentSource: "unknown" as const,
        task: t.task,
        name: extras?.names?.[index],
        startedAt: Date.now(),
        lastActionAt: Date.now(),
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: emptyUsage(),
        toolCalls: {},
        completedTurns: 0,
        turnInProgress: false,
        liveLog: [],
      },
  );

  const emitProgress = () => {
    if (!onUpdate) return;
    const running = allResults.filter((r) => r.exitCode === -1).length;
    const done = allResults.filter((r) => r.exitCode !== -1).length;
    onUpdate({
      content: [
        {
          type: "text",
          text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
        },
      ],
      details: (makeDetails.live ?? makeDetails)([...allResults]),
    });
  };

  let heartbeat: NodeJS.Timeout | undefined;
  if (onUpdate) {
    emitProgress();
    heartbeat = setInterval(() => {
      if (allResults.some((r) => r.exitCode === -1)) emitProgress();
    }, PARALLEL_HEARTBEAT_MS);
  }

  let results: SingleResult[];
  try {
    results = await mapConcurrent(tasks, maxConcurrency, async (t, index) => {
      const previousResult = resumeResults?.[index];
      if (previousResult && isResultSuccess(previousResult)) {
        allResults[index] = previousResult;
        emitProgress();
        return previousResult;
      }
      const savedSessionDir = previousResult?.sessionDir;
      const savedSessionDirExists = sessionDirExists(savedSessionDir);
      const shouldResumeThisSession =
        resumeExistingSessions && (!previousResult || !savedSessionDir || savedSessionDirExists);
      const sessionDir = shouldResumeThisSession && savedSessionDirExists ? savedSessionDir : getSessionDir?.(index, t);
      let result: SingleResult;
      try {
        result = await runAgentSubprocess({
          cwd: defaultCwd,
          agents,
          agentName: t.agent,
          task: t.task,
          subagentName: extras?.names?.[index],
          rawPrompt: extras?.rawPrompts === true,
          namesFile: extras?.namesFile,
          budget: extras?.budgets?.[index] ?? previousResult?.budget,
          parentDepth,
          parentAgentStack,
          maxDepth,
          preventCycles,
          signal,
          sessionDir,
          sessionRoot,
          resumeSession: shouldResumeThisSession && !!sessionDir,
          initialResult: previousResult,
          fallbackModel,
          onHandle: (handle) => onHandleForTask?.(index, t, handle),
          onUpdate: (partial) => {
            if (partial.details?.results[0]) {
              allResults[index] = partial.details.results[0];
              emitProgress();
            }
          },
          makeDetails,
        });
      } finally {
        onTaskDone?.(index, t);
      }
      allResults[index] = result;
      emitProgress();
      return result;
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  const successCount = results.filter(isResultSuccess).length;
  const summaries = results.map((r) => {
    const succeeded = isResultSuccess(r);
    const output = succeeded
      ? getFinalOutput(r.messages, r.finalOutput)
      : r.errorMessage || r.stderr || getFinalOutput(r.messages, r.finalOutput);
    const identity = r.name ? `${r.name} (${r.agent})` : r.agent;
    const status = succeeded ? "completed" : r.exitCode === -1 ? "unfinished" : "failed";
    return `[${identity}] ${status}: ${output || "(no output)"}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
      },
    ],
    details: makeDetails(results),
    ...(successCount === results.length ? {} : { isError: true }),
  };
}
