import {
  buildSubagentDetails,
  DEFAULT_DELEGATION_MODE,
  getFinalOutput,
  isResultError,
  SUBAGENT_COMPLETION_TYPE,
  type SingleResult,
  type AsyncExecutionKey,
} from "../types.js";
import { releaseCompletionDelivery, retainCompletionDelivery } from "./async-jobs.js";
import { scheduleSessionTask } from "./runtime.js";
import type { ExtensionState } from "./state.js";
import { readWorkerStops } from "../storage/worker-stops.js";

function explicitlyStopped(state: ExtensionState, result: SingleResult): boolean {
  const submittedAt = result.submittedAt ?? result.startedAt;
  if (!isResultError(result) || !result.name || !state.currentNamesFile || submittedAt === undefined) return false;
  try {
    return (readWorkerStops(state.currentNamesFile).get(result.name) ?? -1) >= submittedAt;
  } catch (error) {
    console.error("[pi-subagent] Cannot check explicit stop marker:", error);
    return false;
  }
}

export function publishCompletion(
  state: ExtensionState,
  result: SingleResult,
  generation: number,
  executionKey?: AsyncExecutionKey,
  brokerJobId?: string,
  interruptEpoch = state.interruptEpoch ?? 0,
): void {
  if (!state.sessionActive || generation !== state.lifecycleGeneration) return;
  const failed = isResultError(result);
  const output = failed
    ? result.errorMessage || result.stderr || getFinalOutput(result.messages, result.finalOutput)
    : getFinalOutput(result.messages, result.finalOutput);
  const stored = failed && !result.errorMessage && result.stderr ? { ...result, errorMessage: result.stderr } : result;
  const content = `Subagent ${result.name ?? result.agent} ${failed ? "failed" : "finished"}:\n${output || "(no output)"}`;
  const details = Object.assign(
    buildSubagentDetails("single", DEFAULT_DELEGATION_MODE, null, [stored]),
    executionKey ? { asyncJobId: executionKey.jobId, asyncTaskIndex: executionKey.taskIndex } : {},
    brokerJobId ? { brokerJobId } : {},
  );
  const deliveryId = retainCompletionDelivery(state, generation);
  let delivered = false;
  const deliver = (interrupted = false) => {
    if (state.pendingCompletionDeliveries.get(deliveryId) !== generation || (delivered && !interrupted)) return;
    try {
      const silent = interrupted || interruptEpoch !== (state.interruptEpoch ?? 0) || explicitlyStopped(state, result);
      state.pi.sendMessage(
        {
          customType: SUBAGENT_COMPLETION_TYPE,
          content: silent ? `Subagent ${result.name} stopped as requested.` : content,
          display: !silent,
          details: Object.assign(details, { asyncDeliveryId: deliveryId }, silent ? { silentStopped: true } : {}),
        },
        silent ? { triggerTurn: false } : { deliverAs: "steer", triggerTurn: true },
      );
      delivered = true;
      // Interrupted deliveries are durable accounting only, with no continuation to await.
      if (silent) releaseCompletionDelivery(state, deliveryId, generation);
      // Normal sendMessage returns before queued messages are consumed.
      // Keep its interrupt callback until message_start releases the delivery.
    } catch (error) {
      releaseCompletionDelivery(state, deliveryId, generation);
      console.error("[pi-subagent] Completion delivery failed:", error);
    }
  };
  (state.pendingCompletionInterrupts ??= new Map()).set(deliveryId, () => deliver(true));
  scheduleSessionTask(state, () => deliver(), 0);
}
