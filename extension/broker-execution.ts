import type { AgentConfig } from "../agents.js";
import { isFinishedResult } from "../resume.js";
import type { SubagentBudget } from "../budget.js";
import { readBrokerJob, submitBrokerJob } from "../broker/files.js";
import { WORKER_TOKEN_ENV } from "../runner/tree-admission.js";
import type { SubagentModelSettings } from "../storage/name-records.js";
import { configuredEnv, SETTING_DEFINITIONS, withSessionSettings } from "../settings.js";
import { emptyUsage, getFinalOutput, isResultError, type SingleResult } from "../types.js";
import { publishCompletion } from "./completion.js";
import type { ProgressUpdate } from "./contracts.js";
import { brokerProxyHandle, inheritedBrokerEndpoint, watchOwnedBrokerJob } from "./broker-jobs.js";
import { schedulerFor, type WorkerStatus } from "./scheduler.js";
import type { ExtensionState } from "./state.js";
import type { makeDetailsFactory } from "./details.js";

export interface BrokerExecution {
  tasks: Array<{ agent: string; task: string; intelligence?: string }>;
  agents: AgentConfig[];
  cwd: string;
  signal?: AbortSignal;
  onUpdate?: (partial: ProgressUpdate) => void;
  makeDetails: ReturnType<typeof makeDetailsFactory>;
  resumeResults?: SingleResult[];
  sessionDirs: string[];
  resumeSession: boolean;
  fallbackModel?: string;
  baseId: number;
  extras?: {
    jobId?: string;
    names?: Array<string | undefined>;
    rawPrompts?: boolean;
    budgets?: Array<SubagentBudget | undefined>;
    resumeSettings?: SubagentModelSettings[];
    onScheduled?: (index: number, status: WorkerStatus) => void;
  };
}

export function assertBrokerLaunchReceipts(
  state: ExtensionState,
  admissions: Array<WorkerStatus | "completed">,
  cyclic: ReadonlySet<number>,
  previous?: SingleResult[],
): void {
  if (
    state.currentDepth > 0 &&
    admissions.some(
      (status, index) => !cyclic.has(index) && status === "completed" && previous?.[index]?.exitCode !== 0,
    )
  )
    throw new Error("The root broker did not durably acknowledge every task. No launch receipt was issued.");
}

/** Every descriptor is committed synchronously before waiting for global admission. */
export async function executeBrokerParallel(state: ExtensionState, options: BrokerExecution) {
  const endpoint = inheritedBrokerEndpoint(),
    ownerToken = process.env[WORKER_TOKEN_ENV];
  if (!endpoint || !ownerToken)
    throw new Error("Nested execution requires the root worker broker. No local worker was spawned.");
  const scheduler = schedulerFor(state);
  const generation = state.lifecycleGeneration;
  const submittedAt = Date.now();
  const settings = { ...state.settings };
  // Capture effective caller overrides before serialization strips the settings symbol.
  for (const [, , env] of SETTING_DEFINITIONS) {
    const value = configuredEnv(env, state.settings);
    if (value !== undefined) settings[env] = value;
  }
  const tickets = options.tasks.map((task, index) => {
    const previous = options.resumeResults?.[index];
    if (previous && isFinishedResult(previous))
      return { name: previous.name ?? task.agent, promise: Promise.resolve(previous) };
    const name = options.extras?.names?.[index];
    if (!name) {
      const result: SingleResult = {
        agent: task.agent,
        agentSource: "unknown",
        task: task.task,
        exitCode: 1,
        messages: [],
        stderr: "",
        usage: emptyUsage(),
        toolCalls: {},
        completedTurns: 0,
        turnInProgress: false,
        liveLog: [],
        stopReason: "error",
        errorMessage: "Task was not launched: delegation guards did not assign a durable worker name.",
      };
      publishCompletion(
        state,
        result,
        generation,
        options.extras?.jobId ? { jobId: options.extras.jobId, taskIndex: index } : undefined,
      );
      return { name: task.agent, promise: Promise.resolve(result) };
    }
    const id = options.baseId + index;
    const ticket = scheduler.scheduleRemote(
      name,
      (signal, admission) => {
        if (!admission) throw new Error("Broker task is missing global admission metadata.");
        const receipt = submitBrokerJob(
          endpoint,
          {
            ownerToken,
            ownerId: state.currentOwnerId,
            toolCallId: options.extras?.jobId ?? `broker-${options.baseId}`,
            taskIndex: index,
            name,
            agents: options.agents,
            task,
            cwd: options.cwd,
            settings: withSessionSettings(settings, settings),
            projectTrusted: state.latestSessionCtx?.cwd === options.cwd && state.latestSessionCtx.isProjectTrusted(),
            parentDepth: state.currentDepth,
            maxDepth: state.maxDepth,
            parentAgentStack: state.ancestorAgentStack,
            preventCycles: state.preventCycles,
            budget: options.extras?.budgets?.[index] ?? options.resumeResults?.[index]?.budget,
            sessionDir: options.sessionDirs[index],
            sessionRoot: state.currentSubagentSessionRoot,
            namesFile: state.currentNamesFile,
            resumeSession: options.resumeSession,
            initialResult: options.resumeResults?.[index],
            fallbackModel: options.fallbackModel,
            resumeSettings: options.extras?.resumeSettings?.[index],
            intelligencePresets: state.intelligencePresets,
          },
          admission.token,
        );
        const spec = readBrokerJob(endpoint, receipt.id);
        const handle = brokerProxyHandle(endpoint, spec);
        state.activeSubagents.set(id, { name, agent: task.agent, task: task.task, handle, startedAt: Date.now() });
        scheduler.setSteer(name, (message) => handle.steer(message));
        return watchOwnedBrokerJob(state, endpoint, spec, signal)
          .then((result) => {
            if (generation === state.lifecycleGeneration) {
              const job = options.extras?.jobId ? state.backgroundJobs.get(options.extras.jobId) : undefined;
              if (job) job.names = job.names.filter((item) => item !== name);
              publishCompletion(state, result, generation, { jobId: spec.toolCallId, taskIndex: index }, spec.id);
            }
            return result;
          })
          .finally(() => {
            if (generation === state.lifecycleGeneration) state.activeSubagents.delete(id);
          });
      },
      { signal: options.signal },
    );
    options.extras?.onScheduled?.(index, ticket.status);
    return ticket;
  });
  const results: SingleResult[] = await Promise.all(
    tickets.map((ticket, index) =>
      ticket.promise.catch((error: unknown) => ({
        agent: options.tasks[index].agent,
        agentSource: "unknown" as const,
        task: options.tasks[index].task,
        name: ticket.name,
        submittedAt,
        exitCode: 130,
        messages: [],
        stderr: "",
        usage: emptyUsage(),
        toolCalls: {},
        completedTurns: 0,
        turnInProgress: false,
        liveLog: [],
        stopReason: "aborted",
        errorMessage: error instanceof Error ? error.message : String(error),
      })),
    ),
  );
  return {
    content: results.map((result) => ({
      type: "text" as const,
      text: getFinalOutput(result.messages, result.finalOutput) || result.errorMessage || "(no output)",
    })),
    details: options.makeDetails("parallel")(results),
    ...(results.some(isResultError) ? { isError: true } : {}),
  };
}
