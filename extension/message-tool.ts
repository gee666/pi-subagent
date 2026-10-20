import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Text } from "@earendil-works/pi-tui";
import { discoverAgents, isAgentEnabledAtLayer, type AgentConfig } from "../agents.js";
import { createBudget, overrideResumeBudgets, SubagentBudgetError } from "../budget.js";
import {
  clearResumeActive,
  commitFork,
  forkSessionInto,
  markResumeActive,
  readNamesRegistry,
  resolveResumeTarget,
  updateNameRecord,
} from "../names.js";
import { originalModelSettings } from "../storage/session-settings.js";
import { formatSubagentLabel } from "../ui/agent-label.js";
import { resolveMessageRecipient, type MessageRecipient } from "./message-identity.js";
import { recordToolCallStart, renderMessageResult } from "../render.js";
import { buildSubagentDetails, DEFAULT_DELEGATION_MODE } from "../types.js";
import { startBackground } from "./async-jobs.js";
import { updateLatestBroadcastTargets } from "./broadcast.js";
import { makeDetailsFactory } from "./details.js";
import { executeParallel } from "./execution.js";
import { resumableSubagentsDisabled } from "./policy.js";
import { trackProgress } from "./progress.js";
import { ensureBudget } from "./runtime.js";
import { MessageSubagentParams, validatePreparedArguments } from "./schemas.js";
import type { ExtensionState } from "./state.js";

export function registerMessageSubagentTool(state: ExtensionState) {
  if (resumableSubagentsDisabled(state.settings) && !state.resumeToolRegistered) return;
  state.resumeToolRegistered = true;
  state.pi.registerTool({
    name: "message_subagent",
    label: "Message subagent",
    description:
      state.configuredToolPrompts.message_subagent ??
      "Send a message to one named subagent. Running subagents are steered; idle subagents resume with their saved context and original model settings. Returns without waiting for completion. Optional max_subagents_allowed replaces its lifetime descendant cap without resetting spending or refunding reserved slots. Omit to retain its allowance.",
    parameters: MessageSubagentParams,
    prepareArguments: (args) => {
      if (args && typeof args === "object" && "max_subagents_allowed" in args && args.max_subagents_allowed === null) {
        const { max_subagents_allowed: _omitted, ...rest } = args;
        return validatePreparedArguments(MessageSubagentParams, rest);
      }
      return validatePreparedArguments(MessageSubagentParams, args);
    },

    async execute(toolCallId, rawParams, signal, _onUpdate, ctx) {
      const generation = state.lifecycleGeneration;
      const namesFile = state.currentNamesFile;
      const ownerId = state.currentOwnerId;
      const localGuards = state.activeResumeNames;
      let recipient: MessageRecipient | undefined;
      let guardedName: string | undefined;
      let marked = false;
      let backgroundOwnsCleanup = false;
      const cleanup = async () => {
        try {
          if (marked && guardedName) await clearResumeActive(namesFile, guardedName, ownerId);
        } finally {
          // Session changes can clear and reuse this same Set for new work.
          if (generation === state.lifecycleGeneration && guardedName) localGuards.delete(guardedName);
        }
      };
      const checkCurrent = () => {
        signal?.throwIfAborted();
        if (generation !== state.lifecycleGeneration) throw new Error("Message canceled: session changed.");
      };
      const result = (text: string) => ({
        content: [{ type: "text" as const, text }],
        details: Object.assign(
          buildSubagentDetails("parallel", DEFAULT_DELEGATION_MODE, null, []),
          recipient ? { recipient } : {},
        ),
      });
      try {
        const { name, message, max_subagents_allowed } = validatePreparedArguments(MessageSubagentParams, rawParams);
        recipient = resolveMessageRecipient(state, name);
        checkCurrent();
        if (!state.canDelegate || resumableSubagentsDisabled(state.settings))
          throw new Error("Subagent messaging is disabled for this session.");
        recordToolCallStart(toolCallId);
        updateLatestBroadcastTargets(state, undefined);

        const runningHandle = () => Array.from(state.activeSubagents.values()).find((item) => item.name === name);
        const pendingJob = () => Array.from(state.backgroundJobs.values()).find((job) => job.names.includes(name));
        const waitForJob = async (job: NonNullable<ReturnType<typeof pendingJob>>, untilHandle: boolean) => {
          let settled = false;
          void job.promise.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          while (!settled && job.names.includes(name) && !(untilHandle && runningHandle())) {
            checkCurrent();
            await delay(10, undefined, { signal });
          }
          checkCurrent();
        };
        const overrideBudget = (budget: Parameters<typeof overrideResumeBudgets>[1][number]["budget"] | undefined) => {
          if (max_subagents_allowed === undefined) return;
          if (!budget)
            throw new SubagentBudgetError(
              "This subagent has no recorded budget to resize. Omit max_subagents_allowed.",
            );
          overrideResumeBudgets(
            ensureBudget(state),
            [{ budget, max_subagents_allowed }],
            state.currentDepth === 0 ? "main" : "subagent",
          );
        };

        // A launch may be queued behind another task, or a handle may already
        // be settling. Never open its session file until its job releases it.
        for (;;) {
          checkCurrent();
          const running = runningHandle();
          const job = pendingJob();
          if (running) {
            if (max_subagents_allowed !== undefined) {
              if (!namesFile) throw new Error("No subagent name registry is available in this session.");
              overrideBudget(readNamesRegistry(namesFile).agents[name]?.budget);
            }
            const accepted = await running.handle.steer(message);
            if (accepted !== false) return result(`Message sent to subagent "${name}".`);
            if (running.handle.isSettling?.() === false)
              throw new Error(`Subagent "${name}" could not accept steering. Retry when it is ready.`);
            if (!job) throw new Error(`Subagent "${name}" is settling. Retry when it finishes.`);
            await waitForJob(job, false);
          } else if (job) {
            await waitForJob(job, true);
          } else {
            break;
          }
        }

        if (!namesFile)
          throw new Error(
            "No subagent name registry is available in this session. Subagents cannot be resumed by name here.",
          );
        if (localGuards.has(name))
          throw new Error(`Subagent "${name}" is already being resumed. Retry when it starts.`);
        localGuards.add(name);
        guardedName = name;
        const discovery = discoverAgents(ctx.cwd, "both", state.settings);
        const makeDetails = makeDetailsFactory(discovery.projectAgentsDir, DEFAULT_DELEGATION_MODE);
        const resolution = await resolveResumeTarget(namesFile, name, ownerId);
        checkCurrent();
        if ("error" in resolution) throw new Error(resolution.error);
        recipient = {
          name: resolution.record.name,
          agent: resolution.record.agent,
          intelligence: resolution.record.intelligence,
        };
        const definition = discovery.agents.find((agent) => agent.name === resolution.record.agent);
        if (definition && !isAgentEnabledAtLayer(definition, state.currentDepth + 1, state.maxDepth)) {
          throw new Error(
            `Cannot resume subagent "${name}": agent "${definition.name}" is disabled at layer ${state.currentDepth + 1}.`,
          );
        }
        const hasSessionFiles = (dir: string) => {
          try {
            return fs.readdirSync(dir).some((file) => file.endsWith(".jsonl"));
          } catch {
            return false;
          }
        };
        if (resolution.isFork) {
          if (
            !hasSessionFiles(resolution.sessionDir) &&
            !forkSessionInto(resolution.record.sessionDir, resolution.sessionDir)
          ) {
            throw new Error(
              `Cannot fork subagent "${name}": no session files found in ${resolution.record.sessionDir}.`,
            );
          }
          if (resolution.forkCreated) await commitFork(namesFile, name, ownerId, resolution.sessionDir);
        } else if (!hasSessionFiles(resolution.sessionDir)) {
          throw new Error(
            `Cannot resume subagent "${name}": its session directory ${resolution.sessionDir} has no saved session files.`,
          );
        }
        checkCurrent();
        const marker = await markResumeActive(namesFile, name, ownerId);
        if ("error" in marker) throw new Error(marker.error);
        marked = true;
        checkCurrent();
        const budget =
          resolution.record.budget ?? createBudget(path.join(resolution.record.sessionDir, "legacy-budget"), 0);
        overrideBudget(budget);
        const settings = originalModelSettings(resolution.record);
        await updateNameRecord(namesFile, name, { lastResumePrompt: message, ...settings });
        checkCurrent();

        // Saved sessions still work after their agent definition is removed.
        const agents: AgentConfig[] = [...discovery.agents];
        if (!definition)
          agents.push({
            name: resolution.record.agent,
            description: "(resumed subagent; original agent definition not found)",
            systemPrompt: "",
            model: resolution.record.model,
            tools: resolution.record.tools,
            source: "default",
            filePath: "",
          });
        const baseId = state.nextActiveSubagentId++;
        const trackedOnUpdate = trackProgress(state, toolCallId, baseId, ctx);
        startBackground(
          state,
          toolCallId,
          [name],
          async (backgroundSignal) => {
            if (generation !== state.lifecycleGeneration) throw new Error("Subagent resume canceled: session changed.");
            return executeParallel(
              state,
              [{ agent: resolution.record.agent, task: message }],
              agents,
              ctx.cwd,
              backgroundSignal,
              (partial) => {
                if (generation === state.lifecycleGeneration) trackedOnUpdate(partial);
              },
              makeDetails,
              undefined,
              () => resolution.sessionDir,
              true,
              undefined,
              baseId,
              { jobId: toolCallId, names: [name], budgets: [budget], rawPrompts: true, resumeSettings: [settings] },
            );
          },
          cleanup,
        );
        backgroundOwnsCleanup = true;
        return result(`Subagent "${name}" started in the background.`);
      } catch (error) {
        state.forcedErrorToolCallIds.add(toolCallId);
        const message = error instanceof Error ? error.message : String(error);
        return { ...result(message), isError: true };
      } finally {
        if (!backgroundOwnsCleanup) await cleanup();
      }
    },

    renderCall: (args, theme, context) => {
      const name = typeof args.name === "string" ? args.name : "";
      const cache = context?.state ?? {};
      if (!cache.recipient || cache.recipient.name !== name) cache.recipient = resolveMessageRecipient(state, name);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("message subagent "))}${theme.fg("accent", formatSubagentLabel(cache.recipient))}`,
        0,
        0,
      );
    },
    renderResult: (result, { expanded }, theme, context) => renderMessageResult(result, expanded, theme, context),
  });
}
