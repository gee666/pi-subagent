import * as path from "node:path";
import {
  configuredTotalBudget,
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
    findLastNonResumeModel(ctx) ?? getEnvFallbackModel(ctx),
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
    const limit = state.currentDepth === 0 ? configuredTotalBudget() : 0;
    state.currentBudget = createBudget(
      path.join(
        state.currentSubagentSessionRoot,
        state.currentSessionId.replace(/[^a-zA-Z0-9_.-]+/g, "_"),
        "subagent-budget",
      ),
      limit,
    );
    state.pi.appendEntry?.(SUBAGENT_BUDGET_CUSTOM_TYPE, state.currentBudget);
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

export function formatFooterStatusText(ctx: SessionContext, text: string): string {
  return typeof ctx?.ui?.theme?.fg === "function" ? ctx.ui.theme.fg("dim", text) : text;
}

export function updateCombinedUsageStatus(state: ExtensionState, ctx?: SessionContext): void {
  const targetCtx = ctx ?? state.latestSessionCtx;
  if (!targetCtx?.ui) return;
  try {
    const line = collectCombinedUsageStatusLine(targetCtx, Array.from(state.activeSubagentUsageSummaries.values()));
    if (typeof targetCtx.ui.setStatus !== "function") return;
    targetCtx.ui.setStatus("subagent-usage", line ? formatFooterStatusText(targetCtx, line) : undefined);
  } catch (err) {
    console.error("[pi-subagent] Failed to update combined subagent status line:", err);
  }
}

export function getSessionDirForTask(state: ExtensionState, toolCallId: string, index: number): string {
  if (!state.currentSubagentSessionRoot) {
    throw new Error("Cannot create subagent session dir: subagent session root is not initialized.");
  }
  return buildSubagentSessionDir(state.currentSubagentSessionRoot, state.currentSessionId, toolCallId, index);
}
