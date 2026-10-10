import { type SubagentDetails, isSubagentDetails } from "../types.js";
import { slimDetailsForProgress } from "./progress-details.js";
export { slimDetailsForProgress } from "./progress-details.js";
import { updateLatestBroadcastTargets } from "./broadcast.js";
import type { ProgressUpdate, SessionContext } from "./contracts.js";
import { updateCombinedUsageStatus } from "./runtime.js";
import type { ExtensionState } from "./state.js";
import { collectLiveUsageSummary } from "./usage.js";

export function emitNestedProgressToParent(state: ExtensionState, toolCallId: string, details: SubagentDetails): void {
  if (state.currentDepth <= 0) return;
  try {
    process.stdout.write(
      `${JSON.stringify({
        type: "subagent_progress",
        toolCallId,
        details: slimDetailsForProgress(details),
      })}\n`,
    );
  } catch {
    // Best-effort only. Normal final tool_result_end still carries the durable result.
  }
}

export function trackProgress(
  state: ExtensionState,
  toolCallId: string,
  topLevelBaseId: number,
  ctx: SessionContext,
  onUpdate?: (partial: ProgressUpdate) => void,
): (partial: ProgressUpdate) => void {
  return (partial) => {
    if (isSubagentDetails(partial.details)) {
      state.activeSubagentUsageSummaries.set(toolCallId, collectLiveUsageSummary(partial.details));
      updateLatestBroadcastTargets(state, partial.details, topLevelBaseId);
      updateCombinedUsageStatus(state, ctx);
      emitNestedProgressToParent(state, toolCallId, partial.details);
    }
    onUpdate?.(partial);
  };
}
