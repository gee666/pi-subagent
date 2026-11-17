import { findLatestResumableSubagentCalls, recoveryWorkerLabels } from "../resume.js";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";
import type { SessionContext } from "./contracts.js";
import { getRestorableModel, SUBAGENT_FALLBACK_MODEL_ENV } from "./models.js";
import { ensureSubagentToolActive, hasCliInitialPrompt, isRpcMode } from "./policy.js";
import { restoreModelAfterResumeFailure } from "./runtime.js";
import type { ExtensionState } from "./state.js";

export async function maybeOfferSubagentResume(state: ExtensionState, ctx: SessionContext): Promise<void> {
  // Recovery requires an explicit yes. Print/JSON modes and parent-owned
  // RPC workers have no human dialog responder. Top-level RPC clients can ask.
  if (!ctx.hasUI || state.currentDepth > 0) return;
  const generation = state.lifecycleGeneration;
  const interruptEpoch = state.interruptEpoch ?? 0;
  const resumeEpoch = state.resumeEpoch ?? 0;
  const canceled = () =>
    generation !== state.lifecycleGeneration ||
    interruptEpoch !== (state.interruptEpoch ?? 0) ||
    resumeEpoch !== (state.resumeEpoch ?? 0);
  const restorableModel = getRestorableModel(ctx, state.settings);
  if (restorableModel) {
    state.lastRestorableModel = restorableModel;
    state.resumeModelRegistry = ctx.modelRegistry;
  }

  const plans = findLatestResumableSubagentCalls(ctx);
  if (plans.length === 0) return;
  const totalTaskCount = plans.reduce((sum, plan) => sum + plan.tasks.length, 0);

  const shouldResume = await ctx.ui.confirm(
    "Resume subagents?",
    `Resume ${totalTaskCount} interrupted subagent${totalTaskCount === 1 ? "" : "s"} from saved sessions?\n\n${recoveryWorkerLabels(
      plans,
    )
      .map((label) => `- ${label}`)
      .join("\n")}`,
  );
  if (canceled()) return;
  if (shouldResume !== true) {
    if (ctx.model?.provider === RESUME_PROVIDER) {
      if (restorableModel) {
        await state.pi.setModel(restorableModel);
      } else {
        ctx.ui.notify(
          `Subagent resume was declined, but the current model is the synthetic resume model and no real fallback model is available. Select a real model before continuing, or set ${SUBAGENT_FALLBACK_MODEL_ENV}=provider/model.`,
          "error",
        );
      }
    }
    return;
  }

  if (!restorableModel && ctx.model?.provider === RESUME_PROVIDER) {
    ctx.ui.notify(
      `Cannot resume subagents while on the synthetic resume model because no real fallback model is available. Select a real model or set ${SUBAGENT_FALLBACK_MODEL_ENV}=provider/model.`,
      "error",
    );
    return;
  }

  state.pendingResumePlans = [...plans];
  state.resumeState.plans = [...plans];
  state.resumeState.phase = "tool";
  // After approval, RPC/CLI prompts use the next request rather than
  // inserting an extra user message ahead of their initial prompt.
  const injectOnNextRequest = isRpcMode(process.argv) || hasCliInitialPrompt(process.argv);
  state.resumeState.trigger = injectOnNextRequest ? "nextRequest" : "resumePrompt";
  state.modelToRestoreAfterResume = restorableModel ?? ctx.model;
  state.resumeModelRegistry = ctx.modelRegistry;
  ensureSubagentToolActive(state.pi);
  const resumeModel = ctx.modelRegistry.find(RESUME_PROVIDER, RESUME_MODEL_ID);
  const switched = resumeModel && (await state.pi.setModel(resumeModel));
  if (canceled()) {
    if (generation === state.lifecycleGeneration && restorableModel) await state.pi.setModel(restorableModel);
    return;
  }
  if (!switched) {
    ctx.ui.notify("Failed to switch to synthetic subagent resume model.", "error");
    await restoreModelAfterResumeFailure(state, ctx);
    return;
  }

  // An initial CLI/RPC prompt triggers the approved tool call on its next
  // request. Otherwise queue a visible prompt after the initial chat render.
  if (injectOnNextRequest) {
    ctx.ui.notify(`Resuming ${totalTaskCount} subagents...`, "info");
  } else {
    // Do not start the synthetic resume turn from session_start. Pi renders
    // the resumed chat only after session_start/resources_discover complete;
    // starting now lets that render wipe out the live tool component, so no
    // real-time updates appear. Queue it for resources_discover instead,
    // which is the last extension hook before the initial chat render.
    state.pendingInteractiveResumePrompt = `Resuming ${totalTaskCount} subagents...`;
  }
}
