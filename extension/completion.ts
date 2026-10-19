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

export function publishCompletion(
  state: ExtensionState,
  result: SingleResult,
  generation: number,
  executionKey?: AsyncExecutionKey,
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
  );
  const deliveryId = retainCompletionDelivery(state, generation);
  scheduleSessionTask(
    state,
    () => {
      if (state.pendingCompletionDeliveries.get(deliveryId) !== generation) return;
      try {
        state.pi.sendMessage(
          {
            customType: SUBAGENT_COMPLETION_TYPE,
            content,
            display: true,
            details: Object.assign(details, { asyncDeliveryId: deliveryId }),
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        // sendMessage returns before queued messages are consumed. Only the
        // matching message_start handler may release a successful delivery.
      } catch (error) {
        releaseCompletionDelivery(state, deliveryId, generation);
        console.error("[pi-subagent] Completion delivery failed:", error);
      }
    },
    0,
  );
}
