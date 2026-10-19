import { isRecord } from "../types/records.js";

export const LEAD_MESSAGE_EVENT_TYPE = "subagent_lead_message";
export const LEAD_MESSAGE_STDERR_PREFIX = "[pi-subagent:lead-message] ";
export const MAX_LEAD_MESSAGE_CHARS = 16_384;

export interface LeadMessageEvent {
  type: typeof LEAD_MESSAGE_EVENT_TYPE;
  message: string;
}

export function isLeadMessage(message: unknown): message is string {
  return typeof message === "string" && message.length <= MAX_LEAD_MESSAGE_CHARS && message.trim().length > 0;
}

export function isLeadMessageEvent(event: unknown): event is LeadMessageEvent {
  return isRecord(event) && event.type === LEAD_MESSAGE_EVENT_TYPE && isLeadMessage(event.message);
}

/** One write, with an initial LF to separate an unterminated diagnostic. */
export function encodeLeadMessage(message: string): string {
  if (!isLeadMessage(message)) {
    throw new Error(`Message must contain non-whitespace text and be at most ${MAX_LEAD_MESSAGE_CHARS} characters.`);
  }
  return `\n${LEAD_MESSAGE_STDERR_PREFIX}${JSON.stringify({ type: LEAD_MESSAGE_EVENT_TYPE, message })}\n`;
}

/** Only the dedicated prefix is interpreted as a notification on stderr. */
export function parseLeadMessageStderrLine(line: string): LeadMessageEvent | undefined {
  if (!line.startsWith(LEAD_MESSAGE_STDERR_PREFIX)) return undefined;
  try {
    const event: unknown = JSON.parse(line.slice(LEAD_MESSAGE_STDERR_PREFIX.length));
    return isLeadMessageEvent(event) ? event : undefined;
  } catch {
    return undefined;
  }
}
