import { isRecord } from "./values.js";

/**
 * Return the agent message a persisted session entry contributes.
 *
 * Pi stores `pi.sendMessage()` output (e.g. async subagent completions) as
 * `custom_message` entries rather than `message` entries, and only converts
 * them to `{ role: "custom" }` messages when it builds the LLM context. Code
 * that scans raw session entries must apply the same conversion or it will
 * never see those messages.
 */
export function sessionEntryMessage(entry: unknown): Record<string, unknown> | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.type === "message") return isRecord(entry.message) ? entry.message : undefined;
  if (entry.type !== "custom_message" || typeof entry.customType !== "string") return undefined;
  const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : entry.timestamp;
  return {
    role: "custom",
    customType: entry.customType,
    content: entry.content ?? [],
    display: entry.display,
    details: entry.details,
    timestamp,
  };
}

export function sessionEntryMessages(entries: readonly unknown[]): Record<string, unknown>[] {
  return entries.flatMap((entry) => {
    const message = sessionEntryMessage(entry);
    return message ? [message] : [];
  });
}
