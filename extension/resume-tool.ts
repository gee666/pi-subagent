import { validatePreparedArguments } from "./schemas.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents, isAgentEnabledAtLayer, type AgentConfig } from "../agents.js";
import { createBudget, overrideResumeBudgets, SubagentBudgetError, type SubagentBudget } from "../budget.js";
import {
  clearResumeActive,
  commitFork,
  forkSessionInto,
  markResumeActive,
  readNamesRegistry,
  resolveResumeTarget,
  updateNameRecord,
} from "../names.js";
import { recordToolCallStart, renderResult, renderResumeCall } from "../render.js";
import {
  buildSubagentDetails,
  DEFAULT_DELEGATION_MODE,
  prepareResumeArguments,
  RESUME_SUBAGENTS_TOOL_NAME,
} from "../types.js";
import { updateLatestBroadcastTargets } from "./broadcast.js";
import { makeDetailsFactory } from "./details.js";
import { executeParallel } from "./execution.js";
import { formatModelFlag } from "./models.js";
import { resumableSubagentsDisabled } from "./policy.js";
import { trackProgress } from "./progress.js";
import { ensureBudget, getParentModelForSubagent } from "./runtime.js";
import { normalizeResumes, ResumeSubagentsParams } from "./schemas.js";
import type { ExtensionState } from "./state.js";

export function registerResumeSubagentsTool(state: ExtensionState) {
  if (resumableSubagentsDisabled()) return;
  state.pi.registerTool({
    name: RESUME_SUBAGENTS_TOOL_NAME,
    label: "Resume subagents",
    description:
      state.configuredToolPrompts[RESUME_SUBAGENTS_TOOL_NAME] ??
      [
        "Continue agents by their returned names, keeping their previous context.",
        "Optional max_agents_allowed replaces the lifetime cap, including the resumed agent. Past launches and assigned slots still count. Increases reserve extra slots from the original launcher; omitting it keeps the current allowance.",
        "Pass { resumes: [{ subagent, task }] }. Resumes in one call run in parallel; wait between dependent tasks.",
      ].join("\n"),
    parameters: ResumeSubagentsParams,
    prepareArguments(args) {
      return validatePreparedArguments(ResumeSubagentsParams, prepareResumeArguments(args));
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const toolResult = await (async () => {
        const markedNames: string[] = [];
        const resumeGeneration = state.lifecycleGeneration;
        try {
          recordToolCallStart(toolCallId);
          updateLatestBroadcastTargets(state, undefined);
          const discovery = discoverAgents(ctx.cwd, "both");
          const makeDetails = makeDetailsFactory(discovery.projectAgentsDir, DEFAULT_DELEGATION_MODE);
          const fail = (text: string) => ({
            content: [{ type: "text" as const, text }],
            details: makeDetails("parallel")([]),
            isError: true,
          });

          const resumes = normalizeResumes(params.resumes);
          if (resumes.length === 0) {
            return fail(
              "Invalid parameters. Provide a non-empty resumes array of {subagent, task} objects (both fields are required strings).",
            );
          }

          const duplicates = resumes
            .map((resume) => resume.name)
            .filter((name, index, all) => all.indexOf(name) !== index);
          if (duplicates.length > 0) {
            return fail(
              `Duplicate subagent names in one resume call: ${Array.from(new Set(duplicates)).join(", ")}. Resume each name at most once per call.`,
            );
          }

          if (!state.currentNamesFile) {
            return fail(
              "No subagent name registry is available in this session (sessions may be disabled). Subagents cannot be resumed by name here.",
            );
          }

          // Refuse to resume subagents that are still running or being resumed
          // in this process: continuing a session file while another process is
          // writing it corrupts it. (Cross-process protection comes from the
          // registry markers below.)
          const runningNames = new Set(
            Array.from(state.activeSubagents.values())
              .map((item) => item.name)
              .filter((name): name is string => typeof name === "string"),
          );
          for (const name of state.activeResumeNames) runningNames.add(name);
          const stillRunning = resumes.filter((resume) => runningNames.has(resume.name));
          if (stillRunning.length > 0) {
            return fail(
              `Cannot resume subagents that are still running: ${stillRunning.map((r) => r.name).join(", ")}. Wait for them to finish first.`,
            );
          }
          for (const resume of resumes) state.activeResumeNames.add(resume.name);
          const localGuardedNames = resumes.map((resume) => resume.name);
          const releaseLocalGuards = () => {
            for (const name of localGuardedNames) state.activeResumeNames.delete(name);
          };

          try {
            // Resolve every name to a target session dir (own session or private fork).
            const errors: string[] = [];
            const targets: Array<{
              agent: string;
              task: string;
              sessionDir: string;
              name: string;
              model?: string;
              tools?: string[];
              budget: SubagentBudget;
              max_agents_allowed?: number;
            }> = [];
            const hasSessionFiles = (dir: string): boolean => {
              try {
                return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".jsonl"));
              } catch {
                return false;
              }
            };
            for (const resume of resumes) {
              const resolution = await resolveResumeTarget(state.currentNamesFile, resume.name, state.currentOwnerId);
              if ("error" in resolution) {
                errors.push(resolution.error);
                continue;
              }
              const definition = discovery.agents.find((agent) => agent.name === resolution.record.agent);
              if (definition && !isAgentEnabledAtLayer(definition, state.currentDepth + 1, state.maxDepth)) {
                errors.push(
                  `Cannot resume subagent "${resume.name}": agent "${definition.name}" is disabled at layer ${state.currentDepth + 1}.`,
                );
                continue;
              }
              if (resolution.isFork) {
                if (!hasSessionFiles(resolution.sessionDir)) {
                  if (!forkSessionInto(resolution.record.sessionDir, resolution.sessionDir)) {
                    errors.push(
                      `Cannot fork subagent "${resume.name}": no session files found in ${resolution.record.sessionDir}.`,
                    );
                    continue;
                  }
                }
                if (resolution.forkCreated) {
                  await commitFork(state.currentNamesFile, resume.name, state.currentOwnerId, resolution.sessionDir);
                }
              } else if (!hasSessionFiles(resolution.sessionDir)) {
                errors.push(
                  `Cannot resume subagent "${resume.name}": its session directory ${resolution.sessionDir} has no saved session files (the original run may have failed before doing anything).`,
                );
                continue;
              }
              targets.push({
                agent: resolution.record.agent,
                task: resume.task,
                sessionDir: resolution.sessionDir,
                name: resume.name,
                model: resolution.record.model,
                tools: resolution.record.tools,
                budget:
                  resolution.record.budget ?? createBudget(path.join(resolution.record.sessionDir, "legacy-budget"), 0),
                max_agents_allowed: resume.max_agents_allowed,
              });
            }
            if (errors.length > 0) {
              releaseLocalGuards();
              const known = Object.keys(readNamesRegistry(state.currentNamesFile).agents).sort();
              return fail(
                `${errors.join("\n")}\n\nKnown subagent names: ${known.length > 0 ? known.join(", ") : "(none)"}.`,
              );
            }

            // Cross-process in-flight markers: another live pi process resuming
            // the same target must not race us into the same session file.
            const markerErrors: string[] = [];
            for (const target of targets) {
              const marked = await markResumeActive(state.currentNamesFile, target.name, state.currentOwnerId);
              if ("error" in marked) {
                markerErrors.push(marked.error);
              } else {
                markedNames.push(target.name);
              }
            }
            if (markerErrors.length > 0) {
              releaseLocalGuards();
              return fail(markerErrors.join("\n"));
            }

            if (resumeGeneration !== state.lifecycleGeneration || signal?.aborted) {
              return fail("Resume canceled or session changed. No budgets were changed.");
            }
            const overrides = targets.flatMap((target) =>
              target.max_agents_allowed === undefined
                ? []
                : [{ budget: target.budget, max_agents_allowed: target.max_agents_allowed }],
            );
            if (overrides.length) {
              overrideResumeBudgets(ensureBudget(state), overrides, state.currentDepth === 0 ? "main" : "subagent");
            }
            for (const target of targets) {
              await updateNameRecord(state.currentNamesFile, target.name, { lastResumePrompt: target.task });
            }

            // Resumed agents may reference agent types whose definition files no
            // longer exist; the session itself carries all needed context, so
            // synthesize a config from the registry record instead of failing.
            const agentsForResume: AgentConfig[] = [...discovery.agents];
            for (const target of targets) {
              if (!agentsForResume.some((agent) => agent.name === target.agent)) {
                agentsForResume.push({
                  name: target.agent,
                  description: "(resumed subagent; original agent definition not found)",
                  systemPrompt: "",
                  model: target.model,
                  tools: target.tools,
                  source: "builtin",
                  filePath: "",
                });
              }
            }

            const tasks = targets.map((target) => ({ agent: target.agent, task: target.task }));
            const topLevelBaseId = state.nextActiveSubagentId;
            state.nextActiveSubagentId += tasks.length;
            const trackedOnUpdate = trackProgress(state, toolCallId, topLevelBaseId, ctx, onUpdate);

            return await executeParallel(
              state,
              tasks,
              agentsForResume,
              ctx.cwd,
              signal,
              trackedOnUpdate,
              makeDetails,
              undefined,
              (index) => targets[index].sessionDir,
              true,
              formatModelFlag(getParentModelForSubagent(state, ctx)),
              topLevelBaseId,
              {
                names: targets.map((target) => target.name),
                budgets: targets.map((target) => target.budget),
                rawPrompts: true,
              },
            );
          } finally {
            releaseLocalGuards();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
          return {
            content: [
              {
                type: "text" as const,
                text: err instanceof SubagentBudgetError ? msg : `[pi-subagent] Unexpected error: ${msg}${stack}`,
              },
            ],
            details: buildSubagentDetails("parallel", DEFAULT_DELEGATION_MODE, null, []),
            isError: true,
          };
        } finally {
          if (state.currentNamesFile) {
            for (const name of markedNames) {
              await clearResumeActive(state.currentNamesFile, name, state.currentOwnerId);
            }
          }
        }
      })();
      if ("isError" in toolResult && toolResult.isError === true) state.forcedErrorToolCallIds.add(toolCallId);
      return toolResult;
    },

    renderCall: (args, theme, context) => renderResumeCall(args, theme, context),
    renderResult: (result, { expanded }, theme, context) => renderResult(result, expanded, theme, context),
  });
}
