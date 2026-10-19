import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { encodeLeadMessage, MAX_LEAD_MESSAGE_CHARS } from "../runner/lead-message.js";
import { SUBAGENT_DEPTH_ENV } from "../runner/constants.js";

const parameters = Type.Object({
  message: Type.String({
    description: "Notification for your immediate lead agent. No reply is awaited.",
    minLength: 1,
    maxLength: MAX_LEAD_MESSAGE_CHARS,
  }),
});

export function createLeadMessageTool(): ToolDefinition<typeof parameters, undefined> {
  return {
    name: "message_lead_agent",
    label: "Message lead agent",
    description:
      "Send an asynchronous notification to the agent that delegated your task. Use it for findings, blockers, or coordination. Continue your work after sending; this tool does not wait for a reply.",
    parameters,
    async execute(_toolCallId, { message }, signal) {
      const depth = Number(process.env[SUBAGENT_DEPTH_ENV]);
      if (!Number.isSafeInteger(depth) || depth <= 0) {
        throw new Error("No immediate lead message transport is available for this agent.");
      }
      signal?.throwIfAborted();
      const line = encodeLeadMessage(message);
      // Wait only for the local pipe write, never for the lead's callback or a reply.
      await new Promise<void>((resolve, reject) => {
        process.stderr.write(line, (error) => (error ? reject(error) : resolve()));
      });
      return {
        content: [{ type: "text", text: "Message queued for your immediate lead agent. No reply is awaited." }],
        details: undefined,
      };
    },
  };
}

/** Call from the main extension for children, independently of delegation capacity. */
export function registerLeadMessageTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(createLeadMessageTool());
}
