import { isRecord } from "./contracts.js";
import * as path from "node:path";
import { discoverAgents } from "../agents.js";
import {
  findPersistedBudget,
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
import { filterAgentsForPrompt, resumableSubagentsDisabled } from "./policy.js";
import { maybeOfferSubagentResume } from "./resume-offer.js";
import { clearSyntheticResumeState, restoreModelAfterResumeFailure, updateCombinedUsageStatus } from "./runtime.js";
import type { ExtensionState } from "./state.js";

export function registerSessionLifecycle(state: ExtensionState): void {
  state.pi.on("session_start", async (event, ctx) => {
    state.lifecycleGeneration += 1;
    state.sessionActive = true;
    state.latestSessionCtx = ctx;
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
    const includeProjectConfig = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
    state.refreshRegisteredToolPrompts?.(ctx.cwd, includeProjectConfig);
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
      const restorableModel = getRestorableModel(ctx);
      if (restorableModel) {
        state.lastRestorableModel = restorableModel;
        state.resumeModelRegistry = ctx.modelRegistry;
      }
      if (ctx.model?.provider === RESUME_PROVIDER && restorableModel) {
        await state.pi.setModel(restorableModel);
      }

      if (!state.canDelegate) return;

      const discovery = discoverAgents(ctx.cwd, "both");
      state.discoveredAgents = filterAgentsForPrompt(
        discovery.agents,
        state.currentDepth,
        state.maxDepth,
        state.ancestorAgentStack,
        state.preventCycles,
      );
      state.currentSessionId = ctx.sessionManager.getSessionId?.() ?? "ephemeral";
      state.currentSubagentSessionRoot = getDefaultSubagentSessionRoot(ctx);
      if (resumableSubagentsDisabled()) {
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

      if (state.discoveredAgents.length > 0 && ctx.hasUI) {
        const list = state.discoveredAgents.map((a) => `  - ${a.name} (${a.source})`).join("\n");
        ctx.ui.notify(`Found ${state.discoveredAgents.length} subagent(s):\n${list}`, "info");
      }

      const resumeDisabled = parseBooleanEnv(process.env[SUBAGENT_RESUME_DISABLE_ENV]) === true;
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
