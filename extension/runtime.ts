import { truncateToWidth } from "@earendil-works/pi-tui";
import { configuredEnv, loadSubagentSettings } from "../settings.js";
import * as path from "node:path";
import {
  configuredTotalBudget,
  setSessionBudgetLimit,
  createBudget,
  readBudget,
  SUBAGENT_BUDGET_CUSTOM_TYPE,
  SubagentBudgetError,
  type SubagentBudget,
} from "../budget.js";
import { buildSubagentSessionDir } from "../resume.js";
import { RESUME_PROVIDER } from "../shared.js";
import type { ResumeModel, SessionContext } from "./contracts.js";
import { findLastNonResumeModel, getEnvFallbackModel, selectParentModelForSubagent } from "./models.js";
import type { ExtensionState } from "./state.js";
import { collectCombinedUsageStatusLine } from "./usage.js";

export function clearSyntheticResumeState(state: ExtensionState): void {
  state.recoveryPlansByToolCallId?.clear();
  state.resumeState.plans = [];
  state.resumeState.phase = "tool";
  state.resumeState.trigger = "resumePrompt";
}

export function getParentModelForSubagent(state: ExtensionState, ctx: SessionContext): ResumeModel | undefined {
  const currentModel = ctx?.model;
  // Avoid historical lookup during normal calls: the current assistant
  // response is the one that emitted the subagents tool call.
  if (currentModel?.provider && currentModel.provider !== RESUME_PROVIDER) {
    return currentModel;
  }
  return selectParentModelForSubagent(
    currentModel,
    state.modelToRestoreAfterResume,
    findLastNonResumeModel(ctx) ?? getEnvFallbackModel(ctx, state.settings),
    state.lastRestorableModel,
  );
}

export function scheduleSessionTask(state: ExtensionState, callback: () => void, delayMs: number): void {
  const expectedGeneration = state.lifecycleGeneration;
  const timer = setTimeout(() => {
    state.scheduledTasks.delete(timer);
    if (!state.sessionActive || expectedGeneration !== state.lifecycleGeneration) return;
    callback();
  }, delayMs);
  state.scheduledTasks.add(timer);
}

export async function restoreVisibleModelForResume(
  state: ExtensionState,
  expectedGeneration = state.lifecycleGeneration,
): Promise<ResumeModel | undefined> {
  if (!state.sessionActive || expectedGeneration !== state.lifecycleGeneration) return undefined;
  const restore = state.modelToRestoreAfterResume ?? state.lastRestorableModel;
  if (!restore) return undefined;
  state.lastRestorableModel = restore;
  if (state.latestSessionCtx?.model?.provider === RESUME_PROVIDER) {
    try {
      await state.pi.setModel(restore);
    } catch (err) {
      if (state.sessionActive && expectedGeneration === state.lifecycleGeneration) {
        console.error("[pi-subagent] Failed to restore real model during resume:", err);
      }
    }
  }
  return restore;
}

export function ensureBudget(state: ExtensionState): SubagentBudget {
  if (state.budgetSetupError) throw state.budgetSetupError;
  if (!state.currentBudget) {
    if (!state.currentSubagentSessionRoot)
      throw new SubagentBudgetError(
        "Session budget is not initialized. Start or reload the session before launching agents.",
      );
    // Older nested sessions without a recorded grant must not get a new root allowance.
    let limit = 0;
    if (state.currentDepth === 0) {
      try {
        limit = configuredTotalBudget(
          configuredEnv(
            "PI_SUBAGENT_MAX_TOTAL_AGENTS",
            loadSubagentSettings(state.latestSessionCtx?.cwd, state.latestSessionCtx?.isProjectTrusted() === true),
          ),
        );
      } catch (error) {
        // A valid session command can repair an invalid configured allowance,
        // without making that temporary grant the saved baseline.
        if (state.sessionSettings?.PI_SUBAGENT_MAX_TOTAL_AGENTS === undefined) throw error;
      }
    }
    state.currentBudget = createBudget(
      path.join(
        state.currentSubagentSessionRoot,
        state.currentSessionId.replace(/[^a-zA-Z0-9_.-]+/g, "_"),
        "subagent-budget",
      ),
      limit,
    );
    state.pi.appendEntry?.(SUBAGENT_BUDGET_CUSTOM_TYPE, state.currentBudget);
    if (state.currentDepth === 0 && state.sessionSettings?.PI_SUBAGENT_MAX_TOTAL_AGENTS !== undefined)
      setSessionBudgetLimit(state.currentBudget, Number(state.sessionSettings.PI_SUBAGENT_MAX_TOTAL_AGENTS));
  }
  readBudget(state.currentBudget);
  return state.currentBudget;
}

export async function restoreModelAfterResumeFailure(
  state: ExtensionState,
  ctx?: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
) {
  if (!state.sessionActive) return;
  const restore = state.modelToRestoreAfterResume;
  state.modelToRestoreAfterResume = undefined;
  state.pendingResumePlans = [];
  clearSyntheticResumeState(state);
  if (!restore) return;
  try {
    await state.pi.setModel(restore);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx?.ui?.notify?.(`Failed to restore model after subagent resume error: ${message}`, "error");
    console.error("[pi-subagent] Failed to restore model after resume error:", err);
  }
}

export function updateCombinedUsageStatus(state: ExtensionState, ctx?: SessionContext): void {
  const targetCtx = ctx ?? state.latestSessionCtx;
  if (targetCtx?.mode !== "tui" || !targetCtx.hasUI || typeof targetCtx.ui?.setWidget !== "function") return;
  try {
    const line = state.disabled
      ? undefined
      : collectCombinedUsageStatusLine(targetCtx, Array.from(state.activeSubagentUsageSummaries.values()), true);
    targetCtx.ui.setWidget(
      "subagent-usage",
      line
        ? (_tui, theme) => ({
            render: (width) => [theme.fg("dim", truncateToWidth(line, Math.max(0, width), ""))],
            invalidate() {},
          })
        : undefined,
      { placement: "belowEditor" },
    );
  } catch (err) {
    console.error("[pi-subagent] Failed to update combined subagent usage widget:", err);
  }
}

export function getSessionDirForTask(state: ExtensionState, toolCallId: string, index: number): string {
  if (!state.currentSubagentSessionRoot) {
    throw new Error("Cannot create subagent session dir: subagent session root is not initialized.");
  }
  return buildSubagentSessionDir(state.currentSubagentSessionRoot, state.currentSessionId, toolCallId, index);
}
