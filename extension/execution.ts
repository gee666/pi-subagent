import { type AgentConfig } from "../agents.js";
import { type SubagentBudget } from "../budget.js";
import { isFinishedResult } from "../resume.js";
import { executeParallelSubprocess, runAgentSubprocess } from "../runner.js";
import { type SingleResult, getFinalOutput, isResultError } from "../types.js";
import { updateLatestBroadcastTargets } from "./broadcast.js";
import type { ProgressUpdate } from "./contracts.js";
import { makeDetailsFactory } from "./details.js";
import type { ExtensionState } from "./state.js";

export function formatNameSuffix(result: SingleResult | undefined): string {
  return result?.name ? `\n\n(subagent: ${result.name} (${result.agent}) — resume with the name ${result.name})` : "";
}

export async function executeSingle(
  state: ExtensionState,
  agentName: string,
  task: string,
  agents: AgentConfig[],
  defaultCwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: ProgressUpdate) => void) | undefined,
  makeDetails: ReturnType<typeof makeDetailsFactory>,
  previousResult: SingleResult | undefined,
  sessionDir: string,
  resumeExistingSession: boolean,
  fallbackModel: string | undefined,
  topLevelBaseId: number,
  subagentName?: string,
  budget?: SubagentBudget,
) {
  if (previousResult && isFinishedResult(previousResult)) {
    return {
      content: [
        {
          type: "text" as const,
          text: (getFinalOutput(previousResult.messages) || "(no output)") + formatNameSuffix(previousResult),
        },
      ],
      details: makeDetails("single")([previousResult]),
    };
  }

  let activeId: number | undefined;
  let result: SingleResult;
  try {
    result = await runAgentSubprocess({
      cwd: defaultCwd,
      agents,
      agentName,
      task,
      subagentName,
      budget: budget ?? previousResult?.budget,
      parentDepth: state.currentDepth,
      parentAgentStack: state.ancestorAgentStack,
      maxDepth: state.maxDepth,
      preventCycles: state.preventCycles,
      signal,
      onUpdate,
      makeDetails: makeDetails("single"),
      sessionDir: previousResult?.sessionDir ?? sessionDir,
      sessionRoot: state.currentSubagentSessionRoot,
      namesFile: state.currentNamesFile || undefined,
      resumeSession: resumeExistingSession,
      initialResult: previousResult,
      fallbackModel,
      onHandle: (handle) => {
        activeId = topLevelBaseId;
        state.activeSubagents.set(activeId, { agent: agentName, task, handle, name: subagentName });
        updateLatestBroadcastTargets(state, undefined);
      },
    });
  } finally {
    if (activeId !== undefined) {
      state.activeSubagents.delete(activeId);
      updateLatestBroadcastTargets(state, undefined);
    }
  }

  if (isResultError(result)) {
    const errorMsg =
      result.errorMessage || result.stderr || getFinalOutput(result.messages, result.finalOutput) || "(no output)";
    return {
      content: [
        {
          type: "text" as const,
          text: `${result.name ? `${result.name} (${result.agent})` : `Agent ${result.agent}`} ${result.stopReason || "failed"}: ${errorMsg}`,
        },
      ],
      details: makeDetails("single")([result]),
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: (getFinalOutput(result.messages, result.finalOutput) || "(no output)") + formatNameSuffix(result),
      },
    ],
    details: makeDetails("single")([result]),
  };
}

export async function executeParallel(
  state: ExtensionState,
  tasks: Array<{ agent: string; task: string }>,
  agents: AgentConfig[],
  defaultCwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: ProgressUpdate) => void) | undefined,
  makeDetails: ReturnType<typeof makeDetailsFactory>,
  resumeResults: SingleResult[] | undefined,
  getSessionDir: (index: number) => string,
  resumeExistingSessions: boolean,
  fallbackModel: string | undefined,
  topLevelBaseId: number,
  extras?: { names?: Array<string | undefined>; rawPrompts?: boolean; budgets?: Array<SubagentBudget | undefined> },
) {
  const taskIds = new Map<number, number>();
  try {
    return await executeParallelSubprocess(
      tasks,
      agents,
      defaultCwd,
      state.currentDepth,
      state.maxDepth,
      state.ancestorAgentStack,
      state.preventCycles,
      signal,
      onUpdate,
      makeDetails("parallel"),
      resumeResults,
      (index) => getSessionDir(index),
      resumeExistingSessions,
      state.currentSubagentSessionRoot,
      fallbackModel,
      (index, task, handle) => {
        const id = topLevelBaseId + index;
        taskIds.set(index, id);
        state.activeSubagents.set(id, { agent: task.agent, task: task.task, handle, name: extras?.names?.[index] });
        updateLatestBroadcastTargets(state, undefined);
      },
      (index) => {
        const id = taskIds.get(index);
        if (id !== undefined) {
          state.activeSubagents.delete(id);
          updateLatestBroadcastTargets(state, undefined);
        }
      },
      { ...extras, namesFile: state.currentNamesFile || undefined },
    );
  } finally {
    for (const id of taskIds.values()) state.activeSubagents.delete(id);
    updateLatestBroadcastTargets(state, undefined);
  }
}
