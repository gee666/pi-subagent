import { publishCompletion } from "./completion.js";
import { notifyLead } from "./async-jobs.js";
import { type AgentConfig } from "../agents.js";
import { type SubagentBudget } from "../budget.js";
import { isFinishedResult } from "../resume.js";
import { executeParallelSubprocess, runAgentSubprocess } from "../runner.js";
import { type SingleResult, getFinalOutput, isResultError } from "../types.js";
import { formatSubagentLabel } from "../ui/agent-label.js";
import { updateLatestBroadcastTargets } from "./broadcast.js";
import type { ProgressUpdate } from "./contracts.js";
import { makeDetailsFactory } from "./details.js";
import type { ExtensionState } from "./state.js";
import { schedulerFor, type WorkerStatus } from "./scheduler.js";
import { executeBrokerParallel } from "./broker-execution.js";

export function formatNameSuffix(result: SingleResult | undefined): string {
  return result?.name ? `\n\n(subagent: ${formatSubagentLabel(result)} — resume with the name ${result.name})` : "";
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
  intelligence?: string,
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

  if (state.currentDepth > 0)
    return executeBrokerParallel(state, {
      tasks: [{ agent: agentName, task, intelligence }],
      agents,
      cwd: defaultCwd,
      signal,
      onUpdate,
      makeDetails,
      resumeResults: previousResult ? [previousResult] : undefined,
      sessionDirs: [previousResult?.sessionDir ?? sessionDir],
      resumeSession: resumeExistingSession,
      fallbackModel,
      baseId: topLevelBaseId,
      extras: { names: [subagentName], budgets: [budget] },
    });
  const generation = state.lifecycleGeneration;
  const scheduler = schedulerFor(state);
  const workerName = subagentName ?? `single-${crypto.randomUUID()}`;
  let activeId: number | undefined;
  let result: SingleResult;
  try {
    result = await scheduler.schedule(
      workerName,
      (taskSignal, treeAdmission) =>
        runAgentSubprocess({
          treeAdmission,
          cwd: defaultCwd,
          settings: state.settings,
          projectTrusted: state.latestSessionCtx?.cwd === defaultCwd && state.latestSessionCtx.isProjectTrusted(),
          agents,
          agentName,
          task,
          subagentName,
          budget: budget ?? previousResult?.budget,
          parentDepth: state.currentDepth,
          parentAgentStack: state.ancestorAgentStack,
          maxDepth: state.maxDepth,
          preventCycles: state.preventCycles,
          signal: taskSignal,
          onUpdate,
          makeDetails: makeDetails("single"),
          sessionDir: previousResult?.sessionDir ?? sessionDir,
          sessionRoot: state.currentSubagentSessionRoot,
          namesFile: state.currentNamesFile || undefined,
          resumeSession: resumeExistingSession,
          initialResult: previousResult,
          fallbackModel,
          intelligence,
          intelligencePresets: state.intelligencePresets,
          onHandle: (handle) => {
            if (taskSignal.aborted || generation !== state.lifecycleGeneration) {
              handle.kill?.();
              return;
            }
            scheduler.setSteer(workerName, (message) => handle.steer(message));
            activeId = topLevelBaseId;
            state.activeSubagents.set(activeId, {
              agent: agentName,
              task,
              handle,
              name: subagentName,
              startedAt: Date.now(),
            });
            updateLatestBroadcastTargets(state, undefined);
          },
        }),
      { signal, onCancel: () => state.activeSubagents.get(topLevelBaseId)?.handle.kill?.() },
    ).promise;
  } finally {
    if (activeId !== undefined && generation === state.lifecycleGeneration) {
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
          text: `${formatSubagentLabel(result)} ${result.stopReason || "failed"}: ${errorMsg}`,
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
  tasks: Array<{ agent: string; task: string; intelligence?: string }>,
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
  extras?: {
    jobId?: string;
    names?: Array<string | undefined>;
    rawPrompts?: boolean;
    budgets?: Array<SubagentBudget | undefined>;
    resumeSettings?: Array<import("../storage/name-records.js").SubagentModelSettings>;
    onScheduled?: (index: number, status: WorkerStatus) => void;
  },
) {
  if (state.currentDepth > 0)
    return executeBrokerParallel(state, {
      tasks,
      agents,
      cwd: defaultCwd,
      signal,
      onUpdate,
      makeDetails,
      resumeResults,
      sessionDirs: tasks.map((_task, index) => getSessionDir(index)),
      resumeSession: resumeExistingSessions,
      fallbackModel,
      baseId: topLevelBaseId,
      extras,
    });
  const generation = state.lifecycleGeneration;
  const scheduler = schedulerFor(state);
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
        if (generation !== state.lifecycleGeneration) {
          handle.kill?.();
          return;
        }
        const id = topLevelBaseId + index;
        taskIds.set(index, id);
        state.activeSubagents.set(id, {
          agent: task.agent,
          task: task.task,
          handle,
          name: extras?.names?.[index],
          startedAt: Date.now(),
        });
        const name = extras?.names?.[index];
        if (name) scheduler.setSteer(name, (message) => handle.steer(message));
        updateLatestBroadcastTargets(state, undefined);
      },
      (index) => {
        if (generation !== state.lifecycleGeneration) return;
        const id = taskIds.get(index);
        if (id !== undefined) {
          state.activeSubagents.delete(id);
          taskIds.delete(index);
          updateLatestBroadcastTargets(state, undefined);
        }
      },
      {
        ...extras,
        scheduler,
        onCancelTask: (index) => {
          if (generation === state.lifecycleGeneration)
            state.activeSubagents.get(topLevelBaseId + index)?.handle.kill?.();
        },
        compactCompletedResults: true,
        cancelOnError: true,
        onResult: (index, result) => {
          const job = extras?.jobId ? state.backgroundJobs.get(extras.jobId) : undefined;
          if (job && result.name) job.names = job.names.filter((name) => name !== result.name);
          publishCompletion(
            state,
            result,
            generation,
            extras?.jobId ? { jobId: extras.jobId, taskIndex: index } : undefined,
          );
        },
        onLeadMessage: (index, task, message) =>
          notifyLead(state, `Message from subagent ${extras?.names?.[index] ?? task.agent}:\n${message}`, generation),
        settings: state.settings,
        namesFile: state.currentNamesFile || undefined,
        intelligencePresets: state.intelligencePresets,
        projectTrusted: state.latestSessionCtx?.cwd === defaultCwd && state.latestSessionCtx.isProjectTrusted(),
      },
    );
  } finally {
    if (generation === state.lifecycleGeneration) {
      for (const id of taskIds.values()) state.activeSubagents.delete(id);
      updateLatestBroadcastTargets(state, undefined);
    }
  }
}
