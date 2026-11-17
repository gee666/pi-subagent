import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RESUME_PROVIDER } from "./shared.js";
import { isRecord } from "./storage/values.js";

// Synchronous (legacy) launches block the main turn, so they can only have
// been interrupted when nothing but abort cleanup follows them.

function getMessageText(message: unknown): string {
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function messageHasToolCall(message: unknown): boolean {
  return (
    isRecord(message) &&
    Array.isArray(message.content) &&
    message.content.some((part) => isRecord(part) && part.type === "toolCall")
  );
}

function isIgnorableTrailingAbortMessage(entry: unknown): boolean {
  if (!isRecord(entry) || entry.type !== "message") return true;
  const message = entry.message;
  if (!isRecord(message)) return true;

  // Pi may append a final aborted/error assistant message after it has already
  // closed an interrupted tool with a synthetic toolResult. That message is not
  // user-visible progress after the subagent activity.
  return (
    message.role === "assistant" &&
    (message.stopReason === "aborted" || message.stopReason === "error") &&
    getMessageText(message).trim().length === 0 &&
    !messageHasToolCall(message)
  );
}

function isResumePromptEntry(entry: unknown): boolean {
  if (!isRecord(entry) || entry.type !== "message") return false;
  const message = entry.message;
  if (!isRecord(message) || message.role !== "user") return false;
  return /^Resuming \d+ subagents\.\.\.$/.test(getMessageText(message).trim());
}

function isSyntheticResumeModelChange(entry: unknown): boolean {
  return isRecord(entry) && entry.type === "model_change" && entry.provider === RESUME_PROVIDER;
}

function isFailedResumeAttemptTail(entries: SessionEntry[], start: number): boolean {
  let sawSyntheticModel = false;
  let sawResumePrompt = false;
  let sawFailure = false;

  for (let i = start; i < entries.length; i++) {
    const entry = entries[i];
    if (isSyntheticResumeModelChange(entry)) {
      sawSyntheticModel = true;
      continue;
    }
    if (entry?.type === "thinking_level_change") continue;
    if (isResumePromptEntry(entry)) {
      if (!sawSyntheticModel) return false;
      sawResumePrompt = true;
      continue;
    }
    if (isIgnorableTrailingAbortMessage(entry)) {
      if (entry?.type === "message" && sawResumePrompt) sawFailure = true;
      continue;
    }
    return false;
  }

  return sawSyntheticModel && sawResumePrompt && sawFailure;
}

/** Whether only abort cleanup or a failed synthetic resume attempt follows `activityOrder`. */
export function hasOnlyIgnorableTrailingEntries(entries: SessionEntry[], activityOrder: number): boolean {
  const start = activityOrder + 1;
  for (let i = start; i < entries.length; i++) {
    if (!isIgnorableTrailingAbortMessage(entries[i])) return isFailedResumeAttemptTail(entries, start);
  }
  return true;
}
