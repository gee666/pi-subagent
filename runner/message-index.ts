import { createHash } from "node:crypto";
import { isRecord } from "../types/records.js";
import type { TranscriptMessage } from "../types/transcript.js";

interface MessageIndex {
  length: number;
  buckets: Map<string, TranscriptMessage[]>;
}

// Finalized messages are immutable; histories may be resumed, replaced, or appended to.
// Weak keys keep the index out of durable results and release it with the history.
const indexes = new WeakMap<TranscriptMessage[], MessageIndex>();

function messageDedupKey(value: unknown): string {
  const message = isRecord(value) ? value : {};
  if (typeof message.id === "string") return `id:${message.id}`;
  return JSON.stringify({
    role: message.role,
    provider: message.provider,
    model: message.model,
    stopReason: message.stopReason,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content,
    usage: message.usage,
  });
}

function fingerprint(key: string): string {
  // Preserve distinct UTF-16 strings, including lone surrogates in legacy ids.
  return createHash("sha256").update(key, "utf16le").digest("hex");
}

function indexMessage(index: MessageIndex, message: TranscriptMessage, hash: string): void {
  const bucket = index.buckets.get(hash);
  if (bucket) bucket.push(message);
  else index.buckets.set(hash, [message]);
  index.length++;
}

/** Append once using the historical equality key, without retaining serialized content. */
export function appendUniqueMessage(messages: TranscriptMessage[], message: TranscriptMessage): boolean {
  let index = indexes.get(messages);
  if (!index || index.length > messages.length) {
    index = { length: 0, buckets: new Map() };
    indexes.set(messages, index);
  }
  // Seed resumed histories once and catch up with external append-only accumulation.
  while (index.length < messages.length) {
    const existing = messages[index.length];
    indexMessage(index, existing, fingerprint(messageDedupKey(existing)));
  }

  const key = messageDedupKey(message);
  const hash = fingerprint(key);
  // Verify matching fingerprints so even a hash collision cannot change equality.
  if (index.buckets.get(hash)?.some((existing) => messageDedupKey(existing) === key)) return false;
  messages.push(message);
  indexMessage(index, message, hash);
  return true;
}
