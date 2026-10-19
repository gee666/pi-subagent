import { refreshWorkerAllowance } from "./tool-registration.js";
import { registerAsyncDeliveryEvents } from "./async-jobs.js";
import { configuredEnv } from "../settings.js";
import { SUBAGENT_RESUME_DISABLE_ENV, parseBooleanEnv } from "../resume.js";
import { RESUME_PROVIDER } from "../shared.js";
import { isSubagentToolName, subagentDetailsHaveErrors } from "../types.js";
import { decodeNestedBroadcast, forwardNestedBroadcast } from "./broadcast.js";
import { RESUME_INTERACTIVE_DELAY_MS } from "./models.js";
import { maybeOfferSubagentResume } from "./resume-offer.js";
import { restoreModelAfterResumeFailure, scheduleSessionTask, updateCombinedUsageStatus } from "./runtime.js";
import type { ExtensionState } from "./state.js";

export function registerSessionEvents(state: ExtensionState): void {
  registerAsyncDeliveryEvents(state);
  state.pi.on("session_tree", async (event, ctx) => {
    state.latestSessionCtx = ctx;
    updateCombinedUsageStatus(state, ctx);
    try {
      if (!state.canDelegate) return;
      // Skip extension-driven navigation (e.g. compaction) and any state where
      // a resume is already pending or subagents are still running.
      if (event?.fromExtension) return;
      if (state.activeSubagents.size > 0) return;
      if (state.pendingResumePlans.length > 0) return;
      if (state.pendingInteractiveResumePrompt) return;
      if (ctx.model?.provider === RESUME_PROVIDER) return;
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;

      const resumeDisabled = parseBooleanEnv(configuredEnv(SUBAGENT_RESUME_DISABLE_ENV, state.settings)) === true;
      if (resumeDisabled) return;

      await maybeOfferSubagentResume(state, ctx, { deferInteractivePrompt: false });
    } catch (err) {
      console.error("[pi-subagent] Error in session_tree:", err);
      await restoreModelAfterResumeFailure(state, ctx);
    }
  });

  state.pi.on("agent_end", async (_event, ctx) => {
    updateCombinedUsageStatus(state, ctx);
    await restoreModelAfterResumeFailure(state);
  });

  state.pi.on("message_end", (_event, ctx) => {
    state.latestSessionCtx = ctx;
    updateCombinedUsageStatus(state, ctx);
    scheduleSessionTask(state, () => updateCombinedUsageStatus(state, ctx), 0);
  });

  state.pi.on("tool_result", (event) => {
    if (!isSubagentToolName(event?.toolName)) return;
    const detailsFailed = subagentDetailsHaveErrors(event.details);
    const forced = state.forcedErrorToolCallIds.delete(event.toolCallId);
    if (forced || detailsFailed) return { isError: true };
  });

  state.pi.on("tool_execution_end", (event, ctx) => {
    state.latestSessionCtx = ctx;
    if (isSubagentToolName(event.toolName)) {
      if (!state.backgroundJobs.has(event.toolCallId)) state.activeSubagentUsageSummaries.delete(event.toolCallId);
      updateCombinedUsageStatus(state, ctx);
      scheduleSessionTask(state, () => updateCombinedUsageStatus(state, ctx), 0);
    }
  });

  state.pi.on("resources_discover", (_event, ctx) => {
    const prompt = state.pendingInteractiveResumePrompt;
    if (!prompt) return;
    state.pendingInteractiveResumePrompt = null;
    scheduleSessionTask(
      state,
      () => {
        try {
          state.pi.sendUserMessage(prompt);
        } catch (err) {
          console.error("[pi-subagent] Failed to start deferred resume turn:", err);
          void restoreModelAfterResumeFailure(state, ctx);
        }
      },
      RESUME_INTERACTIVE_DELAY_MS,
    );
  });

  state.pi.on("input", async (event, ctx) => {
    const isEnvelope = decodeNestedBroadcast(event.text) !== null;
    try {
      refreshWorkerAllowance(state, ctx);
      // Only explicit nested routing is intercepted. Human input and messages
      // from children always reach the lead without prompting or broadcasting.
      if (isEnvelope) await forwardNestedBroadcast(state, event.text, ctx);
    } catch (err) {
      console.error("[pi-subagent] Error while forwarding subagent message:", err);
    }
    // Even failed or stale routing must not leak its envelope into the model.
    return isEnvelope ? { action: "handled" as const } : { action: "continue" as const };
  });
}
