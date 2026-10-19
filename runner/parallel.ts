import { loadSubagentSettings } from "../settings.js";
import type { AgentConfig } from "../agents.js";
import { selectIntelligence } from "../intelligence.js";
import { formatSubagentLabel } from "../ui/agent-label.js";
import {
  type SingleResult,
  type SubagentDetails,
  emptyUsage,
  isResultSuccess,
  getFinalOutput,
  compactSingleResultForDurableDetails,
  isResultError,
  usageSummaryToUsageStats,
} from "../types.js";
import type { SubagentBudget } from "../budget.js";
import {
  DEFAULT_MAX_PARALLEL_TASKS,
  DEFAULT_MAX_CONCURRENCY,
  PARALLEL_HEARTBEAT_MS,
  SUBAGENT_MAX_PARALLEL_TASKS_ENV,
  SUBAGENT_MAX_CONCURRENCY_ENV,
  mapConcurrent,
} from "../shared.js";
import type { DetailsFactory, OnUpdateCallback, RunningSubagentHandle, RunAgentOptions } from "./options.js";
import { configuredNonNegativeInt } from "./constants.js";
import { sessionDirExists } from "./files.js";
import { runAgentSubprocess } from "./single.js";
import { ProgressCoalescer } from "./progress-coalescer.js";
export async function executeParallelSubprocess(
  tasks: Array<{ agent: string; task: string; intelligence?: string }>,
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
    intelligencePresets?: RunAgentOptions["intelligencePresets"];
    resumeSettings?: Array<NonNullable<RunAgentOptions["resumeSettings"]>>;
    projectTrusted?: boolean;
    settings?: RunAgentOptions["settings"];
    onResult?: (index: number, result: SingleResult) => void;
    /** Async owners persist each completion; release its transcript before slower siblings finish. */
    compactCompletedResults?: boolean;
    /** Background owners must not drop tracking while sibling subprocesses still run. */
    cancelOnError?: boolean;
    /** Immediate-child notifications with task identity; never awaited. */
    onLeadMessage?: (index: number, task: { agent: string; task: string }, message: string) => void | Promise<void>;
  },
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
  isError?: boolean;
}> {
  extras = {
    ...extras,
    settings: extras?.settings ?? loadSubagentSettings(defaultCwd, extras?.projectTrusted === true),
  };
  const maxParallelTasks = configuredNonNegativeInt(
    SUBAGENT_MAX_PARALLEL_TASKS_ENV,
    DEFAULT_MAX_PARALLEL_TASKS,
    true,
    extras?.settings,
  );
  const maxConcurrency = configuredNonNegativeInt(
    SUBAGENT_MAX_CONCURRENCY_ENV,
    DEFAULT_MAX_CONCURRENCY,
    true,
    extras?.settings,
  );

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

  const completed = (result: SingleResult): SingleResult => {
    if (!extras?.compactCompletedResults) return result;
    const compact = compactSingleResultForDurableDetails(result);
    // stderr is transient, but stderr-only failures must retain their explanation.
    if (!compact.errorMessage && isResultError(result)) compact.errorMessage = result.stderr || undefined;
    return compact;
  };
  const childDetails: DetailsFactory = extras?.compactCompletedResults
    ? (results) => ({
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results,
        aggregatedUsage: emptyUsage(),
        aggregatedToolCalls: {},
        usageTree: [],
      })
    : makeDetails;

  const allResults: SingleResult[] = tasks.map((t, index) => {
    const previous = resumeResults?.[index];
    if (previous && isResultSuccess(previous)) return completed(previous);
    let intelligence: string | undefined;
    try {
      intelligence = extras?.resumeSettings
        ? extras.resumeSettings[index].intelligence
        : selectIntelligence(extras?.intelligencePresets, t.intelligence, extras?.settings)?.name;
    } catch {
      // Let the single runner report invalid selections as aligned task failures.
    }
    return {
      ...(previous ?? {
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
      }),
      intelligence,
      ...(extras?.resumeSettings
        ? { model: extras.resumeSettings[index].model, thinking: extras.resumeSettings[index].thinking }
        : {}),
    };
  });

  const batchDetails = (results: SingleResult[], live = false): SubagentDetails => {
    const details = (live ? (makeDetails.live ?? makeDetails) : makeDetails)(results);
    if (!extras?.compactCompletedResults) return details;
    // Legacy aggregate fields still include completed descendants, even though
    // their transcripts are gone. Keep the factory's property enumerability.
    const aggregatedUsage = details.usageSummary
      ? usageSummaryToUsageStats(details.usageSummary)!
      : { ...details.aggregatedUsage };
    if (!details.usageSummary)
      results.forEach((result, index) => {
        const node = details.usageTree?.[index];
        if (!node || result.exitCode === -1 || !result.subtreeUsageSummary || result.messages?.length) return;
        const subtree = usageSummaryToUsageStats(result.subtreeUsageSummary)!;
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"] as const) {
          aggregatedUsage[key] += subtree[key] - node.aggregatedUsage[key];
        }
      });
    const descriptors = Object.getOwnPropertyDescriptors(details);
    descriptors.aggregatedUsage = { ...descriptors.aggregatedUsage, value: aggregatedUsage };
    return Object.create(Object.getPrototypeOf(details), descriptors) as SubagentDetails;
  };

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
      details: batchDetails([...allResults], true),
    });
  };

  const progress = onUpdate ? new ProgressCoalescer(emitProgress) : undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const stopProgress = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    progress?.dispose();
  };

  const cancellation = extras?.cancelOnError ? new AbortController() : undefined;
  const batchSignal = cancellation
    ? signal
      ? AbortSignal.any([signal, cancellation.signal])
      : cancellation.signal
    : signal;
  const running = new Set<Promise<SingleResult>>();
  let results: SingleResult[];
  try {
    if (progress) {
      progress.request(); // Initial snapshot is immediate, including already-aborted calls.
      if (signal?.aborted) stopProgress();
      else {
        heartbeat = setInterval(() => {
          if (allResults.some((r) => r.exitCode === -1)) progress.request();
        }, PARALLEL_HEARTBEAT_MS);
        signal?.addEventListener("abort", stopProgress, { once: true });
      }
    }
    const runTask = async (t: (typeof tasks)[number], index: number): Promise<SingleResult> => {
      const previousResult = resumeResults?.[index];
      if (previousResult && isResultSuccess(previousResult)) {
        extras?.onResult?.(index, previousResult);
        const result = allResults[index];
        progress?.request();
        return result;
      }
      const savedSessionDir = previousResult?.sessionDir;
      const savedSessionDirExists = sessionDirExists(savedSessionDir);
      const shouldResumeThisSession =
        resumeExistingSessions && (!previousResult || !savedSessionDir || savedSessionDirExists);
      const sessionDir = shouldResumeThisSession && savedSessionDirExists ? savedSessionDir : getSessionDir?.(index, t);
      let result: SingleResult;
      const onLeadMessage = extras?.onLeadMessage;
      try {
        result = await runAgentSubprocess({
          cwd: defaultCwd,
          projectTrusted: extras?.projectTrusted,
          settings: extras?.settings,
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
          // Composite signals use weak dependencies rather than N listeners on
          // one caller signal when concurrency is configured into the hundreds.
          signal: batchSignal ? AbortSignal.any([batchSignal]) : undefined,
          sessionDir,
          sessionRoot,
          resumeSession: shouldResumeThisSession && !!sessionDir,
          initialResult: previousResult,
          fallbackModel,
          intelligence: t.intelligence,
          intelligencePresets: extras?.intelligencePresets,
          resumeSettings: extras?.resumeSettings?.[index],
          onHandle: (handle) => onHandleForTask?.(index, t, handle),
          onLeadMessage: onLeadMessage ? (message) => onLeadMessage(index, t, message) : undefined,
          onUpdate: onUpdate
            ? (partial) => {
                if (partial.details?.results[0]) {
                  allResults[index] = partial.details.results[0];
                  progress?.request();
                }
              }
            : undefined,
          makeDetails: childDetails,
        });
      } finally {
        onTaskDone?.(index, t);
      }
      extras?.onResult?.(index, result);
      const retained = completed(result);
      allResults[index] = retained;
      progress?.request();
      return retained;
    };
    results = await mapConcurrent(tasks, maxConcurrency, (task, index) => {
      if (cancellation?.signal.aborted) throw new Error("Parallel batch was cancelled after a task failure.");
      const pending = runTask(task, index);
      running.add(pending);
      void pending.then(
        () => running.delete(pending),
        () => running.delete(pending),
      );
      return pending;
    });
    progress?.flush(); // Publish final results before disposing the limiter.
  } catch (error) {
    stopProgress();
    if (cancellation) {
      cancellation.abort();
      await Promise.allSettled([...running]);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", stopProgress);
    stopProgress();
  }

  const successCount = results.filter(isResultSuccess).length;
  const summaries = results.map((r) => {
    const succeeded = isResultSuccess(r);
    const output = succeeded
      ? getFinalOutput(r.messages, r.finalOutput)
      : r.errorMessage || r.stderr || getFinalOutput(r.messages, r.finalOutput);
    const label = formatSubagentLabel(r);
    const identity = r.name || r.agent || r.intelligence ? `[${label}]` : label;
    const status = succeeded ? "completed" : r.exitCode === -1 ? "unfinished" : "failed";
    return `${identity} ${status}: ${output || "(no output)"}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
      },
    ],
    details: batchDetails(results),
    ...(successCount === results.length ? {} : { isError: true }),
  };
}
