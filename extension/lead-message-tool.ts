import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { encodeLeadMessage, MAX_LEAD_MESSAGE_CHARS } from "../runner/lead-message.js";
import { SUBAGENT_DEPTH_ENV } from "../runner/constants.js";
import { openTreeConcurrencyStore, TREE_CONCURRENCY_DIR_ENV, WORKER_TOKEN_ENV } from "../storage/tree-concurrency.js";
import { inheritedBrokerEndpoint } from "./broker-jobs.js";
import { sendBrokerLead } from "../broker/commands.js";

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
      const directory = process.env[TREE_CONCURRENCY_DIR_ENV];
      const token = process.env[WORKER_TOKEN_ENV];
      if (directory || token) {
        if (!directory || !token) throw new Error("Immediate parent metadata is incomplete; message was not sent.");
        const store = openTreeConcurrencyStore(directory);
        const own = store.get(token);
        const parent = own?.parentToken ? store.get(own.parentToken) : undefined;
        if (parent && ["parking", "suspended", "waking"].includes(parent.status))
          throw new Error("Cannot message your parent: it is suspended while children run. Wait until it resumes.");
        if (parent && parent.status !== "running") throw new Error("Cannot message your parent: it is not running.");
      }
      const endpoint = inheritedBrokerEndpoint();
      const own = directory && token ? openTreeConcurrencyStore(directory).get(token) : undefined;
      if (endpoint && own?.parentToken) {
        if (!(await sendBrokerLead(endpoint, token!, message)))
          throw new Error("Your parent did not accept this message. It may be suspended or no longer running.");
        return {
          content: [{ type: "text", text: "Message accepted by your immediate lead agent. No reply is awaited." }],
          details: undefined,
        };
      }
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
