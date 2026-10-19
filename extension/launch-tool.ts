import { createIntelligenceSchemas, validatePreparedArguments } from "./schemas.js";
import { selectIntelligence } from "../intelligence.js";
import { resolveLaunchModelSettings } from "../runner/arguments.js";
import * as path from "node:path";
import { DEFAULT_AGENT, discoverAgents } from "../agents.js";
import {
  createBudget,
  isBranchBudgetAmount,
  reserveSubagentBudgets,
  SubagentBudgetError,
  type SubagentBudget,
} from "../budget.js";
import { allocateSubagentNames } from "../names.js";
import { recordToolCallStart, renderCall, renderResult } from "../render.js";
import { getTaskBranchSize } from "../resume.js";
import { buildSubagentDetails, DEFAULT_DELEGATION_MODE, SUBAGENT_TOOL_NAME } from "../types.js";
import { updateLatestBroadcastTargets } from "./broadcast.js";
import { makeDetailsFactory } from "./details.js";
import { executeParallel } from "./execution.js";
import { startBackground } from "./async-jobs.js";
import { startedResult } from "./launch-result.js";
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
import {
  findRecoveryPlanIndex,
  getPreparedRecoveryPlan,
  prepareIntelligenceArguments,
  prepareRecoveryArguments,
} from "./schemas.js";
import type { ExtensionState } from "./state.js";

export function registerSubagentsTool(state: ExtensionState) {
  const hasAgentTypes = state.discoveredAgents.length > 0;
  const parameters = createIntelligenceSchemas(state.intelligencePresets, state.settings, hasAgentTypes).subagents;
  state.pi.registerTool({
    name: SUBAGENT_TOOL_NAME,
    label: "Subagents",
    description: state.configuredToolPrompts[SUBAGENT_TOOL_NAME] ?? getSubagentsToolDescription(hasAgentTypes),
    parameters,
    prepareArguments(args) {
      return validatePreparedArguments(
        parameters,
        prepareRecoveryArguments(
          prepareIntelligenceArguments(args, "tasks"),
          state.pendingResumePlans,
          state.intelligencePresets,
          state.settings,
          hasAgentTypes,
        ),
      );
    },

    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const toolResult = await (async () => {
        try {
          if (!state.canDelegate) throw new Error("Subagent delegation is disabled for this session.");
          recordToolCallStart(toolCallId);
          updateLatestBroadcastTargets(state, undefined);
          const discovery = discoverAgents(ctx.cwd, "both", state.settings);
          const agents = hasAgentTypes
            ? filterAgentsForCurrentLayer(discovery.agents, state.currentDepth, state.maxDepth)
            : [DEFAULT_AGENT];

          const makeDetails = makeDetailsFactory(discovery.projectAgentsDir, DEFAULT_DELEGATION_MODE);

          const tasks = (params.tasks ?? []).map((task) => ({ ...task, agent: task.agent ?? DEFAULT_AGENT.name }));
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
            selectIntelligence(state.intelligencePresets, task.intelligence, state.settings);
            if (!isBranchBudgetAmount(task.max_subagents_allowed)) {
              throw new SubagentBudgetError(
                `tasks[${index}].max_subagents_allowed is required. Use a non-negative safe integer below Number.MAX_SAFE_INTEGER, excluding the assigned agent. Use 0 for a direct worker.`,
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
          const trackedOnUpdate = trackProgress(state, toolCallId, topLevelBaseId, ctx);

          // Cyclic tasks must not block legal siblings or consume durable names.
          const cyclicTaskIndexes = new Set<number>();
          if (state.preventCycles) {
            const stack = new Set(state.ancestorAgentStack);
            tasks.forEach((task, index) => {
              if (hasAgentTypes && stack.has(task.agent)) cyclicTaskIndexes.add(index);
            });
          }
          const requested = new Set<string>();
          tasks.forEach((task, index) => {
            if (!cyclicTaskIndexes.has(index)) requested.add(task.agent);
          });

          const requestedProjectAgents = getRequestedProjectAgents(agents, requested);
          const projectAgentConfirmationSetting = getProjectAgentConfirmationSetting(state.settings);
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

          const boundPlan = state.recoveryPlansByToolCallId?.get(toolCallId) ?? getPreparedRecoveryPlan(params);
          const resumePlanIndex = boundPlan
            ? state.pendingResumePlans.indexOf(boundPlan)
            : findRecoveryPlanIndex(
                tasks,
                state.pendingResumePlans,
                state.intelligencePresets,
                state.settings,
                hasAgentTypes,
              );
          if (
            boundPlan &&
            (resumePlanIndex < 0 ||
              findRecoveryPlanIndex(tasks, [boundPlan], state.intelligencePresets, state.settings, hasAgentTypes) < 0)
          ) {
            throw new Error("Subagent recovery plan is no longer pending or its arguments have changed.");
          }
          const resumePlan = resumePlanIndex >= 0 ? state.pendingResumePlans[resumePlanIndex] : null;
          if (resumePlan) {
            tasks.forEach((task, index) => {
              if (!hasAgentTypes) task.agent = resumePlan.tasks[index].agent;
              if (!agents.some((agent) => agent.name === task.agent)) {
                agents.push({ ...DEFAULT_AGENT, name: task.agent });
              }
            });
          }
          if (launchGeneration !== state.lifecycleGeneration || signal?.aborted)
            throw new SubagentBudgetError("Launch canceled or session changed. No slots were reserved.");
          const budgets: Array<SubagentBudget | undefined> = tasks.map(() => undefined);
          const runnable = tasks
            .map((task, index) => ({ task, index }))
            .filter(
              ({ task, index }) => !cyclicTaskIndexes.has(index) && agents.some((agent) => agent.name === task.agent),
            );
          if (resumePlan && resumePlan.tasks.every((task) => getTaskBranchSize(task) === undefined)) {
            // Legacy recovery cannot grant fresh descendant allowances.
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
                max_subagents_allowed: task.max_subagents_allowed,
              })),
              state.currentDepth === 0 ? "main" : "subagent",
            );
            runnable.forEach(({ index }, position) => {
              budgets[index] = reserved[position];
            });
          }

          if (resumePlanIndex >= 0) state.pendingResumePlans.splice(resumePlanIndex, 1);
          state.recoveryPlansByToolCallId?.delete(toolCallId);

          // Names are unique across the tree and reused during recovery.
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
                    const preset = selectIntelligence(state.intelligencePresets, task.intelligence, state.settings);
                    return {
                      agent: task.agent,
                      task: task.task,
                      budget: budgets[index],
                      ...resolveLaunchModelSettings(
                        agentConfig ?? {},
                        formatModelFlag(getParentModelForSubagent(state, ctx)),
                        preset,
                        state.settings,
                      ),
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
          startBackground(
            state,
            toolCallId,
            names.filter((name): name is string => !!name),
            (jobSignal) =>
              executeParallel(
                state,
                tasks,
                agents,
                ctx.cwd,
                jobSignal,
                trackedOnUpdate,
                makeDetails,
                resumePlan?.details?.results,
                (index) => getSessionDirForTask(state, resumePlan?.previousToolCallId ?? toolCallId, index),
                !!resumePlan,
                formatModelFlag(getParentModelForSubagent(state, ctx)),
                topLevelBaseId,
                { jobId: toolCallId, names, budgets },
              ),
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Started ${tasks.length} subagent(s): ${tasks.map((task, index) => names[index] || task.agent || "worker").join(", ")}. Completion messages will arrive asynchronously. Keep working in parallel.`,
              },
            ],
            details: Object.assign(
              makeDetails(executionMode)(
                tasks.map((task, index) =>
                  startedResult(
                    task,
                    names[index],
                    budgets[index],
                    getSessionDirForTask(state, resumePlan?.previousToolCallId ?? toolCallId, index),
                  ),
                ),
              ),
              { asyncJobId: toolCallId },
            ),
          };
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
