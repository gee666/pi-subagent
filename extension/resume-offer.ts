import { findLatestResumableSubagentCalls, parseBooleanEnv, SUBAGENT_RESUME_PROMPT_ENV } from "../resume.js";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";
import type { SessionContext } from "./contracts.js";
import { getRestorableModel, RESUME_INTERACTIVE_DELAY_MS, SUBAGENT_FALLBACK_MODEL_ENV } from "./models.js";
import { ensureSubagentToolActive, hasCliInitialPrompt, isRpcMode } from "./policy.js";
import { restoreModelAfterResumeFailure, scheduleSessionTask } from "./runtime.js";
import type { ExtensionState } from "./state.js";

export async function maybeOfferSubagentResume(
  state: ExtensionState,
  ctx: SessionContext,
  opts: { deferInteractivePrompt: boolean },
): Promise<void> {
  const restorableModel = getRestorableModel(ctx);
  if (restorableModel) {
    state.lastRestorableModel = restorableModel;
    state.resumeModelRegistry = ctx.modelRegistry;
  }

  const plans = findLatestResumableSubagentCalls(ctx);
  if (plans.length === 0) return;
  const totalTaskCount = plans.reduce((sum, plan) => sum + plan.tasks.length, 0);

  let shouldResume = true;
  const shouldPrompt = parseBooleanEnv(process.env[SUBAGENT_RESUME_PROMPT_ENV]) !== false;
  const rpcMode = isRpcMode(process.argv);
  if (ctx.hasUI && !rpcMode && shouldPrompt) {
    shouldResume = await ctx.ui.confirm(
      "Resume subagents?",
      `The resumed session has ${plans.length === 1 ? "an" : String(plans.length)} unfinished subagent call${plans.length === 1 ? "" : "s"} (${totalTaskCount} task${totalTaskCount === 1 ? "" : "s"}). Resume from saved subagent sessions?`,
    );
  }
  if (!shouldResume) {
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
  // Headless subprocess/RPC subagents cannot answer a visible resume
  // prompt. They already receive an initial RPC prompt from the parent
  // runner, so inject the synthetic resume tool call into that next model
  // request. Interactive top-level sessions keep using a visible prompt so
  // the user sees exactly what is happening.
  const injectOnNextRequest = rpcMode || hasCliInitialPrompt(process.argv) || !ctx.hasUI;
  state.resumeState.trigger = injectOnNextRequest ? "nextRequest" : "resumePrompt";
  state.modelToRestoreAfterResume = restorableModel ?? ctx.model;
  state.resumeModelRegistry = ctx.modelRegistry;
  ensureSubagentToolActive(state.pi);
  const resumeModel = ctx.modelRegistry.find(RESUME_PROVIDER, RESUME_MODEL_ID);
  if (!resumeModel || !(await state.pi.setModel(resumeModel))) {
    ctx.ui.notify("Failed to switch to synthetic subagent resume model.", "error");
    await restoreModelAfterResumeFailure(state, ctx);
    return;
  }

  // In print/json subprocesses there is already an initial CLI prompt about
  // to be sent. That prompt will be answered by the synthetic provider with
  // a real assistant subagent tool call. In interactive mode, submit a short
  // visible prompt that triggers the same synthetic provider path.
  if (injectOnNextRequest) {
    if (ctx.hasUI) ctx.ui.notify(`Resuming ${totalTaskCount} subagents...`, "info");
  } else if (opts.deferInteractivePrompt) {
    // Do not start the synthetic resume turn from session_start. Pi renders
    // the resumed chat only after session_start/resources_discover complete;
    // starting now lets that render wipe out the live tool component, so no
    // real-time updates appear. Queue it for resources_discover instead,
    // which is the last extension hook before the initial chat render.
    state.pendingInteractiveResumePrompt = `Resuming ${totalTaskCount} subagents...`;
  } else {
    scheduleSessionTask(
      state,
      () => {
        try {
          state.pi.sendUserMessage(`Resuming ${totalTaskCount} subagents...`);
        } catch (err) {
          console.error("[pi-subagent] Failed to start resume turn after tree navigation:", err);
          void restoreModelAfterResumeFailure(state, ctx);
        }
      },
      RESUME_INTERACTIVE_DELAY_MS,
    );
  }
}
