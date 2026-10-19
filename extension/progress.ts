import { type SubagentDetails, isSubagentDetails } from "../types.js";
import { slimDetailsForProgress } from "./progress-details.js";
export { slimDetailsForProgress } from "./progress-details.js";
import { updateLatestBroadcastTargets } from "./broadcast.js";
import type { ProgressUpdate, SessionContext } from "./contracts.js";
import { scheduleSessionTask, updateCombinedUsageStatus } from "./runtime.js";
import type { ExtensionState } from "./state.js";
import { collectLiveUsageSummary } from "./usage.js";

export function emitNestedProgressToParent(state: ExtensionState, toolCallId: string, details: SubagentDetails): void {
  // Transient snapshots are disposable. Never enqueue them behind a saturated
  // protocol pipe; the next heartbeat retries and durable results are unchanged.
  if (state.currentDepth <= 0 || process.stdout.writableNeedDrain || process.stdout.destroyed) return;
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

const usageRefreshes = new WeakMap<ExtensionState, { generation: number; last: number; pending: boolean }>();

/** All jobs share the footer's throttle; accounting itself is updated immediately. */
function refreshUsage(state: ExtensionState, ctx: SessionContext): void {
  let refresh = usageRefreshes.get(state);
  if (!refresh || refresh.generation !== state.lifecycleGeneration) {
    refresh = { generation: state.lifecycleGeneration, last: -Infinity, pending: false };
    usageRefreshes.set(state, refresh);
  }
  if (refresh.pending) return;
  const delay = Math.max(0, 100 - (Date.now() - refresh.last));
  if (delay === 0) {
    refresh.last = Date.now();
    updateCombinedUsageStatus(state, ctx);
  } else {
    refresh.pending = true;
    const current = refresh;
    scheduleSessionTask(
      state,
      () => {
        current.pending = false;
        current.last = Date.now();
        updateCombinedUsageStatus(state, ctx);
      },
      delay,
    );
  }
}

export function trackProgress(
  state: ExtensionState,
  toolCallId: string,
  topLevelBaseId: number,
  ctx: SessionContext,
  onUpdate?: (partial: ProgressUpdate) => void,
): (partial: ProgressUpdate) => void {
  const generation = state.lifecycleGeneration;
  return (partial) => {
    if (!state.sessionActive || generation !== state.lifecycleGeneration) return;
    if (isSubagentDetails(partial.details)) {
      state.activeSubagentUsageSummaries.set(toolCallId, collectLiveUsageSummary(partial.details));
      updateLatestBroadcastTargets(state, partial.details, topLevelBaseId);
      refreshUsage(state, ctx);
      emitNestedProgressToParent(state, toolCallId, partial.details);
    }
    onUpdate?.(partial);
  };
}
