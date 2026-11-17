import { refreshWorkerAllowance } from "./tool-registration.js";
import { registerAsyncDeliveryEvents } from "./async-jobs.js";
import { isSubagentToolName, subagentDetailsHaveErrors } from "../types.js";
import { decodeNestedBroadcast, forwardNestedBroadcast } from "./broadcast.js";
import { RESUME_INTERACTIVE_DELAY_MS } from "./models.js";
import {
  restoreModelAfterResumeFailure,
  scheduleSessionTask,
  sendAutomaticResumePrompt,
  updateCombinedUsageStatus,
} from "./runtime.js";
import type { ExtensionState } from "./state.js";

export function registerSessionEvents(state: ExtensionState): void {
  registerAsyncDeliveryEvents(state);
  state.pi.on("session_tree", async (_event, ctx) => {
    state.latestSessionCtx = ctx;
    updateCombinedUsageStatus(state, ctx);
    // Browsing history is read-only for recovery. Invalidate even a startup
    // confirmation or deferred turn approved for the branch we just left.
    state.resumeEpoch = (state.resumeEpoch ?? 0) + 1;
    state.pendingInteractiveResumePrompt = null;
    await restoreModelAfterResumeFailure(state, ctx);
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
    const resumeEpoch = state.resumeEpoch ?? 0;
    scheduleSessionTask(
      state,
      () => {
        if (resumeEpoch !== (state.resumeEpoch ?? 0)) return;
        try {
          sendAutomaticResumePrompt(state, prompt);
        } catch (err) {
          console.error("[pi-subagent] Failed to start deferred resume turn:", err);
          void restoreModelAfterResumeFailure(state, ctx);
        }
      },
      RESUME_INTERACTIVE_DELAY_MS,
      true,
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
