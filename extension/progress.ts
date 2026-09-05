import { type SingleResult, type SubagentDetails, isSubagentDetails, isSubagentToolName } from "../types.js";
import { updateLatestBroadcastTargets } from "./broadcast.js";
import type { ProgressUpdate, SessionContext } from "./contracts.js";
import { updateCombinedUsageStatus } from "./runtime.js";
import type { ExtensionState } from "./state.js";
import { collectLiveUsageSummary } from "./usage.js";

export function slimDetailsForProgress(details: SubagentDetails): SubagentDetails {
  const slimResult = (result: SingleResult): SingleResult => {
    const slimMessages = result.messages
      .map((message) => {
        if (message?.role === "assistant" && Array.isArray(message.content)) {
          const subagentCalls = message.content.filter(
            (part) => part?.type === "toolCall" && isSubagentToolName(part?.name),
          );
          return subagentCalls.length > 0 ? { ...message, content: subagentCalls } : null;
        }
        if (message?.role === "toolResult" && isSubagentToolName(message.toolName)) {
          return isSubagentDetails(message.details)
            ? { ...message, details: slimDetailsForProgress(message.details) }
            : message;
        }
        return null;
      })
      .filter(Boolean) as SingleResult["messages"];

    const liveNestedSubagents = result.liveNestedSubagents
      ? Object.fromEntries(
          Object.entries(result.liveNestedSubagents).map(([nestedToolCallId, nested]) => [
            nestedToolCallId,
            slimDetailsForProgress(nested),
          ]),
        )
      : undefined;

    return {
      ...result,
      messages: slimMessages,
      stderr: result.stderr ? result.stderr.slice(-1000) : "",
      liveLog: [...(result.liveLog ?? [])],
      liveNestedSubagents,
    };
  };

  return {
    ...details,
    results: details.results.map(slimResult),
  };
}

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
