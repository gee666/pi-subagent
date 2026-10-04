import { loadPiSubagentsConfig } from "../config.js";
import { configuredEnv } from "../settings.js";
import { subagentDisabled } from "../runner/extension-policy.js";
import { DEFAULT_MAX_PARALLEL_TASKS, parseNonNegativeInt, SUBAGENT_MAX_PARALLEL_TASKS_ENV } from "../shared.js";
import { resolveDelegationDepthConfig } from "./policy.js";
import { isRecord } from "./contracts.js";
import { SUBAGENT_INTELLIGENCE_CUSTOM_TYPE, SUBAGENT_RUN_INTELLIGENCE_ENV } from "../intelligence.js";
import * as path from "node:path";
import { discoverAgents } from "../agents.js";
import {
  findPersistedBudget,
  readBudget,
  SUBAGENT_BUDGET_CUSTOM_TYPE,
  SUBAGENT_BUDGET_DIR_ENV,
  SubagentBudgetError,
} from "../budget.js";
import {
  findAncestorNamesFile,
  findPersistedNamesIdentity,
  getInheritedNamesFile,
  getNamesFilePath,
  SUBAGENT_NAMES_CUSTOM_TYPE,
} from "../names.js";
import { clearRenderCaches, setHistoricalCallOrder } from "../render.js";
import { getDefaultSubagentSessionRoot, parseBooleanEnv, SUBAGENT_RESUME_DISABLE_ENV } from "../resume.js";
import { RESUME_PROVIDER } from "../shared.js";
import { isSubagentToolName } from "../types.js";
import { getRestorableModel } from "./models.js";
import { ensureSubagentToolActive, filterAgentsForPrompt, resumableSubagentsDisabled } from "./policy.js";
import { maybeOfferSubagentResume } from "./resume-offer.js";
import { clearSyntheticResumeState, restoreModelAfterResumeFailure, updateCombinedUsageStatus } from "./runtime.js";
import type { ExtensionState } from "./state.js";

export function registerSessionLifecycle(state: ExtensionState): void {
  state.pi.on("session_start", async (event, ctx) => {
    state.lifecycleGeneration += 1;
    state.sessionActive = true;
    state.latestSessionCtx = ctx;
    // Record this invocation before its first user message, including on leaf workers.
    // Null clears the label on a resume that uses no preset. Do not rewrite earlier entries.
    const runIntelligence = process.env[SUBAGENT_RUN_INTELLIGENCE_ENV];
    if (runIntelligence !== undefined) {
      try {
        const intelligence: unknown = JSON.parse(runIntelligence);
        if (intelligence === null || (typeof intelligence === "string" && intelligence.trim())) {
          state.pi.appendEntry?.(SUBAGENT_INTELLIGENCE_CUSTOM_TYPE, { intelligence });
        }
      } catch {
        // Ignore malformed external metadata without guessing a preset from the active model.
      }
    }
    const previouslyCouldDelegate = state.canDelegate;
    const previouslyResumable = state.resumesEnabled ?? !resumableSubagentsDisabled(state.settings);
    const includeProjectConfig = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
    const config = loadPiSubagentsConfig(ctx.cwd, includeProjectConfig);
    state.settings = config.settings;
    state.resumesEnabled = !resumableSubagentsDisabled(state.settings);
    Object.assign(state, resolveDelegationDepthConfig(state.pi, state.settings));
    state.disabled = subagentDisabled(process.env, state.settings);
    state.canDelegate = !state.disabled && state.canDelegate;
    state.maxParallelTasks =
      parseNonNegativeInt(configuredEnv(SUBAGENT_MAX_PARALLEL_TASKS_ENV, state.settings)) ?? DEFAULT_MAX_PARALLEL_TASKS;
    state.currentBudget = undefined;
    state.budgetSetupError = undefined;
    try {
      const persisted = findPersistedBudget(ctx.sessionManager.getEntries?.() ?? []);
      const inherited = process.env[SUBAGENT_BUDGET_DIR_ENV];
      if (!persisted && inherited && !path.isAbsolute(inherited)) {
        throw new SubagentBudgetError(
          `Invalid ${SUBAGENT_BUDGET_DIR_ENV}: expected an absolute branch-ledger path. New launches are blocked.`,
        );
      }
      state.currentBudget = persisted ?? (inherited ? { directory: inherited } : undefined);
      if (state.currentBudget && !persisted) state.pi.appendEntry?.(SUBAGENT_BUDGET_CUSTOM_TYPE, state.currentBudget);
      // A zero lifetime descendant allowance means this worker has no children
      // to launch or resume. Exhausted positive allowances must retain resume.
      if (state.currentDepth > 0 && state.currentBudget && readBudget(state.currentBudget).limit === 0) {
        state.canDelegate = false;
      }
    } catch (error) {
      state.budgetSetupError = error;
    }
    const historicalCallIds: string[] = [];
    const leafId = ctx.sessionManager.getLeafId?.();
    const visibleEntries = leafId
      ? (ctx.sessionManager.getBranch?.(leafId) ?? ctx.sessionManager.getEntries?.() ?? [])
      : (ctx.sessionManager.getEntries?.() ?? []);
    for (const rawEntry of visibleEntries) {
      if (!isRecord(rawEntry)) continue;
      const message = isRecord(rawEntry.message) ? rawEntry.message : rawEntry;
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (
          part?.type === "toolCall" &&
          typeof (part.id ?? part.toolCallId) === "string" &&
          isSubagentToolName(part.name)
        ) {
          historicalCallIds.push(part.id ?? part.toolCallId);
        }
      }
    }
    setHistoricalCallOrder(historicalCallIds);
    state.refreshRegisteredToolPrompts?.(ctx.cwd, includeProjectConfig, config);
    // Inactive tools are neither exposed nor callable. Also withdraw a resume tool
    // registered in an earlier session when that session's settings allowed resumes.
    const active = state.pi.getActiveTools();
    const filtered = active.filter(
      (name) =>
        !isSubagentToolName(name) ||
        (state.canDelegate && (name !== "resume_subagents" || !resumableSubagentsDisabled(state.settings))),
    );
    if (filtered.length !== active.length) state.pi.setActiveTools(filtered);
    if (
      state.canDelegate &&
      (!previouslyCouldDelegate || (!previouslyResumable && !resumableSubagentsDisabled(state.settings)))
    ) {
      ensureSubagentToolActive(state.pi, state.settings);
    }
    state.resumeModelRegistry = ctx.modelRegistry;
    clearSyntheticResumeState(state);
    state.pendingResumePlans = [];
    state.pendingInteractiveResumePrompt = null;
    state.modelToRestoreAfterResume = undefined;
    updateCombinedUsageStatus(state, ctx);
    try {
      // Always repair sessions left on the synthetic resume model, even in
      // nested subagents that can no longer delegate. Those leaf processes
      // still need the real model to continue their own work.
      const restorableModel = getRestorableModel(ctx, state.settings);
      if (restorableModel) {
        state.lastRestorableModel = restorableModel;
        state.resumeModelRegistry = ctx.modelRegistry;
      }
      if (ctx.model?.provider === RESUME_PROVIDER && restorableModel) {
        await state.pi.setModel(restorableModel);
      }

      if (!state.canDelegate) return;

      const discovery = discoverAgents(ctx.cwd, "both", state.settings);
      state.discoveredAgents = filterAgentsForPrompt(
        discovery.agents,
        state.currentDepth,
        state.maxDepth,
        state.ancestorAgentStack,
        state.preventCycles,
      );
      state.currentSessionId = ctx.sessionManager.getSessionId?.() ?? "ephemeral";
      state.currentSubagentSessionRoot = getDefaultSubagentSessionRoot(ctx);
      if (resumableSubagentsDisabled(state.settings)) {
        state.currentNamesFile = "";
        state.currentOwnerId = state.currentSessionId;
      } else {
        try {
          // Pi assigns resumed/branched sessions a NEW session id, so the
          // registry path and ownership key must NOT be derived from the live
          // session id alone. Resolution order:
          //   1. identity persisted in the session metadata (custom entry) —
          //      the session's own record always wins
          //   2. env (a child subagent process's FIRST run, before it has
          //      persisted anything)
          //   3. ancestor walk over header.parentSession (self-heals sessions
          //      from before the identity entry existed)
          //   4. fresh path from the current session id
          const inherited = getInheritedNamesFile();
          const persisted = findPersistedNamesIdentity(ctx.sessionManager.getEntries?.() ?? []);
          if (persisted) {
            state.currentNamesFile = persisted.namesFile;
            state.currentOwnerId = persisted.ownerId;
          } else if (inherited) {
            state.currentNamesFile = inherited;
            state.currentOwnerId = state.currentSessionId;
          } else {
            const ancestor = findAncestorNamesFile(
              state.currentSubagentSessionRoot,
              state.currentSessionId,
              ctx.sessionManager.getHeader?.(),
            );
            state.currentNamesFile =
              ancestor?.namesFile ?? getNamesFilePath(state.currentSubagentSessionRoot, state.currentSessionId);
            state.currentOwnerId = ancestor?.ownerId ?? state.currentSessionId;
          }
          // NOTE: the registry path is passed to child processes via their
          // spawn env in the runner. It must NOT be set on process.env here:
          // pi reloads extension modules on session switches, and a self-set
          // env var would then masquerade as "inherited from a parent",
          // overriding the identity persisted in the session being resumed.
          // Persist the identity into the session so the next resume/branch of
          // this session (with whatever new session id pi assigns) finds it.
          if (
            (!persisted ||
              persisted.namesFile !== state.currentNamesFile ||
              persisted.ownerId !== state.currentOwnerId) &&
            typeof state.pi.appendEntry === "function"
          ) {
            state.pi.appendEntry(SUBAGENT_NAMES_CUSTOM_TYPE, {
              namesFile: state.currentNamesFile,
              ownerId: state.currentOwnerId,
            });
          }
        } catch (err) {
          console.error("[pi-subagent] Failed to initialize subagent name registry:", err);
          state.currentNamesFile = "";
          state.currentOwnerId = state.currentSessionId;
        }
      }

      const resumeDisabled = parseBooleanEnv(configuredEnv(SUBAGENT_RESUME_DISABLE_ENV, state.settings)) === true;
      if (resumeDisabled || (event.reason !== "resume" && event.reason !== "startup")) return;

      await maybeOfferSubagentResume(state, ctx, { deferInteractivePrompt: true });
    } catch (err) {
      console.error("[pi-subagent] Error in session_start:", err);
      await restoreModelAfterResumeFailure(state, ctx);
    }
  });

  state.pi.on("session_shutdown", () => {
    state.sessionActive = false;
    state.lifecycleGeneration += 1;
    for (const timer of state.scheduledTasks) clearTimeout(timer);
    state.scheduledTasks.clear();
    clearSyntheticResumeState(state);
    state.pendingResumePlans = [];
    state.pendingInteractiveResumePrompt = null;
    state.modelToRestoreAfterResume = undefined;
    state.latestSessionCtx = undefined;
    state.resumeModelRegistry = undefined;
    state.activeSubagentUsageSummaries.clear();
    state.forcedErrorToolCallIds.clear();
    state.activeSubagents.clear();
    state.activeResumeNames.clear();
    state.approvedProjectAgentDirsForSession.clear();
    state.latestBroadcastTargets.all = [];
    state.latestBroadcastTargets.youngest = [];
    clearRenderCaches();
  });
}
