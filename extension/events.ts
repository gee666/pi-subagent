import { SUBAGENT_RESUME_DISABLE_ENV, parseBooleanEnv } from "../resume.js";
import { RESUME_PROVIDER } from "../shared.js";
import { isSubagentToolName, subagentDetailsHaveErrors } from "../types.js";
import { askBroadcastForSteering, decodeNestedBroadcast } from "./broadcast.js";
import { RESUME_INTERACTIVE_DELAY_MS } from "./models.js";
import { isStreamingSteerInput } from "./policy.js";
import { maybeOfferSubagentResume } from "./resume-offer.js";
import { restoreModelAfterResumeFailure, scheduleSessionTask, updateCombinedUsageStatus } from "./runtime.js";
import type { ExtensionState } from "./state.js";

export function registerSessionEvents(state: ExtensionState): void {
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

      const resumeDisabled = parseBooleanEnv(process.env[SUBAGENT_RESUME_DISABLE_ENV]) === true;
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
      state.activeSubagentUsageSummaries.delete(event.toolCallId);
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
    try {
      // Encoded nested-broadcast envelopes must never leak into this agent's
      // conversation as literal text. Intercept them unconditionally: if the
      // target subagent is gone, the message is dropped (best effort).
      if (decodeNestedBroadcast(event.text)) {
        await askBroadcastForSteering(state, event.text, ctx);
        return { action: "handled" as const };
      }
      // Pi emits this before it applies the built-in streaming behavior. When a
      // subagent tool is running, only mid-stream steering messages should be
      // candidates for child broadcast. Idle prompts and queued follow-ups must
      // continue normally so they reach the parent conversation as intended.
      if (state.activeSubagents.size === 0) return { action: "continue" as const };
      if (!isStreamingSteerInput(event, ctx)) return { action: "continue" as const };
      const result = await askBroadcastForSteering(state, event.text, ctx);
      return result === "handled" ? { action: "handled" as const } : { action: "continue" as const };
    } catch (err) {
      console.error("[pi-subagent] Error while handling steering broadcast:", err);
      return { action: "continue" as const };
    }
  });
}
