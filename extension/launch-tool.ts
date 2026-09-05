import { validatePreparedArguments } from "./schemas.js";
import * as path from "node:path";
import { discoverAgents } from "../agents.js";
import {
  createBudget,
  isBranchBudgetAmount,
  reserveSubagentBudgets,
  SubagentBudgetError,
  type SubagentBudget,
} from "../budget.js";
import { allocateSubagentNames } from "../names.js";
import { recordToolCallStart, renderCall, renderResult } from "../render.js";
import { getTaskBranchSize, sameTasks } from "../resume.js";
import { buildSubagentDetails, DEFAULT_DELEGATION_MODE, SUBAGENT_TOOL_NAME } from "../types.js";
import { updateLatestBroadcastTargets } from "./broadcast.js";
import { makeDetailsFactory } from "./details.js";
import { executeParallel, executeSingle } from "./execution.js";
import { formatModelFlag } from "./models.js";
import {
  confirmProjectAgentsIfNeeded,
  filterAgentsForCurrentLayer,
  formatAgentNames,
  getProjectAgentConfirmationSetting,
  getProjectAgentSessionKey,
  getRequestedProjectAgents,
  isRpcMode,
  SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV,
} from "./policy.js";
import { trackProgress } from "./progress.js";
import { getSubagentsToolDescription } from "./prompts.js";
import { ensureBudget, getParentModelForSubagent, getSessionDirForTask } from "./runtime.js";
import { prepareRecoveryArguments, SubagentParams } from "./schemas.js";
import type { ExtensionState } from "./state.js";

export function registerSubagentsTool(state: ExtensionState) {
  state.pi.registerTool({
    name: SUBAGENT_TOOL_NAME,
    label: "Subagents",
    description: state.configuredToolPrompts[SUBAGENT_TOOL_NAME] ?? getSubagentsToolDescription(),
    parameters: SubagentParams,
    prepareArguments(args) {
      return validatePreparedArguments(SubagentParams, prepareRecoveryArguments(args, state.pendingResumePlans));
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const toolResult = await (async () => {
        try {
          recordToolCallStart(toolCallId);
          updateLatestBroadcastTargets(state, undefined);
          const discovery = discoverAgents(ctx.cwd, "both");
          const agents = filterAgentsForCurrentLayer(discovery.agents, state.currentDepth, state.maxDepth);

          const makeDetails = makeDetailsFactory(discovery.projectAgentsDir, DEFAULT_DELEGATION_MODE);

          const tasks = params.tasks ?? [];
          if (tasks.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Invalid parameters. Provide a non-empty tasks array.\nAvailable agents: ${formatAgentNames(agents)}`,
                },
              ],
              details: makeDetails("single")([]),
              isError: true,
            };
          }

          for (const [index, task] of tasks.entries()) {
            if (!isBranchBudgetAmount(task.max_agents_allowed)) {
              throw new SubagentBudgetError(
                `tasks[${index}].max_agents_allowed is required. Use a positive safe integer, including the assigned agent. Use 1 for a direct worker.`,
              );
            }
          }
          if (tasks.length > state.maxParallelTasks)
            throw new SubagentBudgetError(
              `Too many tasks: ${tasks.length}. Batch capacity is ${state.maxParallelTasks}. No slots were reserved.`,
            );
          if (signal?.aborted) throw new SubagentBudgetError("Launch canceled. No slots were reserved.");
          const launchGeneration = state.lifecycleGeneration;

          const executionMode = tasks.length === 1 ? "single" : "parallel";
          const topLevelBaseId = state.nextActiveSubagentId;
          state.nextActiveSubagentId += tasks.length;
          const trackedOnUpdate = trackProgress(state, toolCallId, topLevelBaseId, ctx, onUpdate);

          // Apply whole-call security preflight only to tasks that can actually
          // run. Cyclic tasks become aligned structured failures in the runner;
          // they must not block legal siblings or consume durable names.
          const cyclicTaskIndexes = new Set<number>();
          if (state.preventCycles) {
            const stack = new Set(state.ancestorAgentStack);
            tasks.forEach((task, index) => {
              if (stack.has(task.agent)) cyclicTaskIndexes.add(index);
            });
          }
          const requested = new Set<string>();
          tasks.forEach((task, index) => {
            if (!cyclicTaskIndexes.has(index)) requested.add(task.agent);
          });

          const requestedProjectAgents = getRequestedProjectAgents(agents, requested);
          const projectAgentConfirmationSetting = getProjectAgentConfirmationSetting();
          const projectAgentSessionKey = getProjectAgentSessionKey(discovery.projectAgentsDir);
          const shouldConfirmProjectAgents =
            requestedProjectAgents.length > 0 &&
            projectAgentConfirmationSetting === "ask" &&
            !state.approvedProjectAgentDirsForSession.has(projectAgentSessionKey);
          if (shouldConfirmProjectAgents) {
            if (ctx.hasUI && !isRpcMode(process.argv)) {
              const approval = await confirmProjectAgentsIfNeeded(
                requestedProjectAgents,
                discovery.projectAgentsDir,
                ctx,
              );
              if (approval === "no") {
                return {
                  content: [
                    {
                      type: "text" as const,
                      text: "Canceled: project-local agents not approved.",
                    },
                  ],
                  details: makeDetails(executionMode)([]),
                };
              }
              if (approval === "session") {
                state.approvedProjectAgentDirsForSession.add(projectAgentSessionKey);
              }
            } else {
              const names = requestedProjectAgents.map((a) => a.name).join(", ");
              const dir = discovery.projectAgentsDir ?? "(unknown)";
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Blocked: project-local agent confirmation is required in non-UI mode.\nAgents: ${names}\nSource: ${dir}\n\nSet ${SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV}=false or =session only if this repository is trusted.`,
                  },
                ],
                details: makeDetails(executionMode)([]),
                isError: true,
              };
            }
          }

          const resumePlanIndex = state.pendingResumePlans.findIndex((plan) => sameTasks(plan.tasks, tasks));
          const resumePlan = resumePlanIndex >= 0 ? state.pendingResumePlans[resumePlanIndex] : null;
          if (launchGeneration !== state.lifecycleGeneration || signal?.aborted)
            throw new SubagentBudgetError("Launch canceled or session changed. No slots were reserved.");
          const budgets: Array<SubagentBudget | undefined> = tasks.map(() => undefined);
          const runnable = tasks
            .map((task, index) => ({ task, index }))
            .filter(
              ({ task, index }) => !cyclicTaskIndexes.has(index) && agents.some((agent) => agent.name === task.agent),
            );
          if (resumePlan && resumePlan.tasks.every((task) => getTaskBranchSize(task) === undefined)) {
            // Pre-budget sessions can resume their existing workers, but cannot
            // acquire fresh descendant allowances through recovery.
            for (const { index } of runnable) {
              budgets[index] =
                resumePlan.details?.results[index]?.budget ??
                createBudget(
                  path.join(
                    resumePlan.details?.results[index]?.sessionDir ??
                      getSessionDirForTask(state, resumePlan.previousToolCallId, index),
                    "legacy-budget",
                  ),
                  0,
                );
            }
          } else if (runnable.length) {
            const reserved = reserveSubagentBudgets(
              ensureBudget(state),
              resumePlan?.previousToolCallId ?? toolCallId,
              runnable.map(({ task }) => ({
                agent: task.agent,
                task: task.task,
                max_agents_allowed: task.max_agents_allowed,
              })),
              state.currentDepth === 0 ? "main" : "subagent",
            );
            runnable.forEach(({ index }, position) => {
              budgets[index] = reserved[position];
            });
          }

          if (resumePlanIndex >= 0) state.pendingResumePlans.splice(resumePlanIndex, 1);

          // Assign random durable human names unique across the whole tree. Resumed
          // runs keep the names already recorded in the previous results.
          const names: Array<string | undefined> = tasks.map(
            (_task, index) => resumePlan?.details?.results[index]?.name,
          );
          if (state.currentNamesFile) {
            const pendingAllocation = tasks
              .map((task, index) => ({ task, index }))
              .filter(({ index }) => !cyclicTaskIndexes.has(index) && !names[index]);
            if (pendingAllocation.length > 0) {
              try {
                const allocated = await allocateSubagentNames(
                  state.currentNamesFile,
                  state.currentOwnerId,
                  pendingAllocation.map(({ task, index }) => {
                    const agentConfig = agents.find((agent) => agent.name === task.agent);
                    return {
                      agent: task.agent,
                      task: task.task,
                      budget: budgets[index],
                      model: formatModelFlag(getParentModelForSubagent(state, ctx)) ?? agentConfig?.model,
                      tools: agentConfig?.tools,
                      sessionDir:
                        resumePlan?.details?.results[index]?.sessionDir ??
                        getSessionDirForTask(state, resumePlan?.previousToolCallId ?? toolCallId, index),
                    };
                  }),
                );
                pendingAllocation.forEach(({ index }, allocIndex) => {
                  names[index] = allocated[allocIndex];
                });
              } catch (err) {
                throw new Error(
                  `Failed to allocate unique subagent names: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }

          if (launchGeneration !== state.lifecycleGeneration || signal?.aborted)
            throw new SubagentBudgetError(
              "Launch canceled after reservation. Reserved slots remain assigned to these branches.",
            );
          if (tasks.length === 1) {
            const [task] = tasks;
            return executeSingle(
              state,
              task.agent,
              task.task,
              agents,
              ctx.cwd,
              signal,
              trackedOnUpdate,
              makeDetails,
              resumePlan?.details?.results[0],
              getSessionDirForTask(state, resumePlan?.previousToolCallId ?? toolCallId, 0),
              !!resumePlan,
              // Normal calls inherit the model that emitted this tool call;
              // synthetic resume calls recover the preceding real model.
              formatModelFlag(getParentModelForSubagent(state, ctx)),
              topLevelBaseId,
              names[0],
              budgets[0],
            );
          }

          return await executeParallel(
            state,
            tasks,
            agents,
            ctx.cwd,
            signal,
            trackedOnUpdate,
            makeDetails,
            resumePlan?.details?.results,
            (index) => getSessionDirForTask(state, resumePlan?.previousToolCallId ?? toolCallId, index),
            !!resumePlan,
            formatModelFlag(getParentModelForSubagent(state, ctx)),
            topLevelBaseId,
            { names, budgets },
          );
        } catch (err) {
          if (err instanceof SubagentBudgetError) {
            return {
              content: [{ type: "text" as const, text: err.message }],
              details: buildSubagentDetails("single", DEFAULT_DELEGATION_MODE, null, []),
              isError: true,
            };
          }
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
          return {
            content: [{ type: "text" as const, text: `[pi-subagent] Unexpected error: ${msg}${stack}` }],
            details: buildSubagentDetails("single", DEFAULT_DELEGATION_MODE, null, []),
            isError: true,
          };
        }
      })();
      if ("isError" in toolResult && toolResult.isError === true) state.forcedErrorToolCallIds.add(toolCallId);
      return toolResult;
    },

    renderCall: (args, theme, context) => renderCall(args, theme, context),
    renderResult: (result, { expanded }, theme, context) => renderResult(result, expanded, theme, context),
  });
}
