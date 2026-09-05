import { isRecord } from "./records.js";

/**
 * A child transcript is an archival record, not an SDK request message.
 * Older Pi versions and extensions omit current SDK metadata or add roles.
 * Content, usage, and details are validated by their readers before use.
 */
export interface TranscriptMessage {
  role: string;
  content?: unknown;
  usage?: unknown;
  details?: unknown;
  id?: string;
  api?: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

const STRING_METADATA = [
  "id",
  "api",
  "provider",
  "model",
  "stopReason",
  "errorMessage",
  "toolCallId",
  "toolName",
] as const;

/** Accept historical messages without asserting that they satisfy the SDK union. */
export function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  return (
    isRecord(value) &&
    typeof value.role === "string" &&
    STRING_METADATA.every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.isError === undefined || typeof value.isError === "boolean") &&
    (value.timestamp === undefined || (typeof value.timestamp === "number" && Number.isFinite(value.timestamp)))
  );
}
