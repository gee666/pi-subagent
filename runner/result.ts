import { emptyUsage, subagentIdentity, type SingleResult, type SubagentUsageSummary } from "../types.js";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";
import { MAX_CAPTURED_STDERR_CHARS } from "./constants.js";
import { recordArray } from "../types/records.js";
export function priorDescendantUsage(result: SingleResult | undefined): SubagentUsageSummary | undefined {
  if (!result) return undefined;
  if (result.priorDescendantUsageSummary) return { ...result.priorDescendantUsageSummary };
  const subtree = result.subtreeUsageSummary;
  if (!subtree) return undefined;
  const own = result.usage ?? emptyUsage();
  const descendants = {
    subagentCount: Math.max(0, subtree.subagentCount - 1),
    ...(subtree.subagentIds
      ? { subagentIds: subtree.subagentIds.filter((id) => id !== subagentIdentity(result)) }
      : {}),
    inputTokens: Math.max(0, subtree.inputTokens - own.input),
    outputTokens: Math.max(0, subtree.outputTokens - own.output),
    cacheReadTokens: Math.max(0, subtree.cacheReadTokens - own.cacheRead),
    cacheWriteTokens: Math.max(0, subtree.cacheWriteTokens - own.cacheWrite),
    costUsd: Math.max(0, subtree.costUsd - own.cost),
    turns: Math.max(0, subtree.turns - own.turns),
  };
  return descendants.subagentCount > 0 ||
    descendants.inputTokens > 0 ||
    descendants.outputTokens > 0 ||
    descendants.costUsd > 0
    ? descendants
    : undefined;
}

export function appendBoundedStderr(result: SingleResult, text: string): void {
  if (!text) return;
  result.stderr += text;
  if (result.stderr.length <= MAX_CAPTURED_STDERR_CHARS) return;
  const omittedNow = result.stderr.length - MAX_CAPTURED_STDERR_CHARS;
  result.stderr = result.stderr.slice(-MAX_CAPTURED_STDERR_CHARS);
  result.stderrTruncatedChars = (result.stderrTruncatedChars ?? 0) + omittedNow;
}

export function endedWithSyntheticResumeFailure(messages: unknown): boolean {
  const assistants = recordArray(messages).filter((message) => message.role === "assistant");
  const lastAssistant = assistants.at(-1);
  if (lastAssistant?.provider !== RESUME_PROVIDER || lastAssistant?.model !== RESUME_MODEL_ID) return false;
  const handedOffToRealModel = assistants.some((message) => message.provider !== RESUME_PROVIDER);
  const hasToolCall = recordArray(lastAssistant.content).some((part) => part.type === "toolCall");
  return !handedOffToRealModel && !hasToolCall;
}
