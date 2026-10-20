import { Container } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildSubagentDetails, DEFAULT_DELEGATION_MODE } from "../types.js";
import { isRecord } from "../types/records.js";
import { renderMessageResult } from "../render.js";
import { MessageSubagentParams, SingleMessageSubagentParams, validatePreparedArguments } from "./schemas.js";
import type { ExtensionState } from "./state.js";

type SingleTool = ToolDefinition<typeof SingleMessageSubagentParams>;

/** Fan out locally. Recipient names never become part of a child's prompt. */
export function registerMessageBatchTool(state: ExtensionState, single: SingleTool): void {
  state.pi.registerTool({
    ...single,
    parameters: MessageSubagentParams,
    description: `${single.description}\nname accepts one name or an array of names to receive the same message concurrently. Each receives only the message, not the recipient list. Duplicate names are contacted once. Optional max_subagents_allowed applies separately to each recipient. Delivery failures are reported per recipient; other deliveries are not rolled back.`,
    prepareArguments(args) {
      if (!isRecord(args)) return validatePreparedArguments(MessageSubagentParams, args);
      const normalized: Record<string, unknown> = {
        ...args,
        name: typeof args.name === "string" ? [args.name] : args.name,
      };
      if (normalized.max_subagents_allowed === null) delete normalized.max_subagents_allowed;
      return validatePreparedArguments(MessageSubagentParams, normalized);
    },
    async execute(id, params, signal, onUpdate, ctx) {
      if (!Array.isArray(params?.name))
        return single.execute(id, { ...params, name: params?.name }, signal, onUpdate, ctx);
      try {
        const validated = validatePreparedArguments(MessageSubagentParams, params);
        const names = [...new Set(validated.name)];
        if (names.length > state.maxTasksPerCall)
          throw new Error(
            `Too many recipients: ${names.length}. Max tasks per call is ${state.maxTasksPerCall}. No messages were sent.`,
          );
        if (names.length === 1) return single.execute(id, { ...validated, name: names[0] }, signal, onUpdate, ctx);
        const results = await Promise.all(
          names.map(async (name, index) => {
            const childId = `${id}/recipient-${index}`;
            try {
              return await single.execute(childId, { ...validated, name }, signal, undefined, ctx);
            } finally {
              state.forcedErrorToolCallIds.delete(childId);
            }
          }),
        );
        const recipients = results.map((result, index) => ({
          ...(isRecord(result.details) && isRecord(result.details.recipient) ? result.details.recipient : {}),
          name: names[index],
          isError: Reflect.get(result, "isError") === true,
          executionStatus: isRecord(result.details) ? result.details.executionStatus : undefined,
          queued: isRecord(result.details) && result.details.queued === true,
          status: result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        }));
        const isError = recipients.some((recipient) => recipient.isError);
        if (isError) state.forcedErrorToolCallIds.add(id);
        return {
          content: [
            { type: "text", text: recipients.map((recipient) => `${recipient.name}: ${recipient.status}`).join("\n") },
          ],
          details: Object.assign(buildSubagentDetails("parallel", DEFAULT_DELEGATION_MODE, null, []), { recipients }),
          ...(isError ? { isError: true } : {}),
        };
      } catch (error) {
        state.forcedErrorToolCallIds.add(id);
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: buildSubagentDetails("parallel", DEFAULT_DELEGATION_MODE, null, []),
          isError: true,
        };
      }
    },
    renderCall(args, theme, context) {
      if (!Array.isArray(args.name)) {
        const singleArgs = { ...args, name: args.name };
        return single.renderCall!(singleArgs, theme, { ...context, args: singleArgs });
      }
      const container = new Container();
      const caches = (context.state.recipientStates ??= new Map());
      for (const name of new Set(args.name)) {
        if (!caches.has(name)) caches.set(name, {});
        const singleArgs = { ...args, name };
        container.addChild(
          single.renderCall!(singleArgs, theme, { ...context, args: singleArgs, state: caches.get(name) }),
        );
      }
      return container;
    },
    renderResult(result, options, theme, context) {
      if (!Array.isArray(context.args.name) || (isRecord(result.details) && isRecord(result.details.recipient))) {
        return single.renderResult!(result, options, theme, {
          ...context,
          args: { ...context.args, name: Array.isArray(context.args.name) ? context.args.name[0] : context.args.name },
        });
      }
      const recipients =
        isRecord(result.details) && Array.isArray(result.details.recipients) ? result.details.recipients : [];
      if (!recipients.length)
        return renderMessageResult(result, options.expanded, theme, {
          ...context,
          args: { message: context.args.message },
        });
      const container = new Container();
      for (const recipient of recipients) {
        if (!isRecord(recipient)) continue;
        container.addChild(
          renderMessageResult(
            {
              content: [
                {
                  type: "text",
                  text: `${recipient.isError === true ? `${recipient.name}: ` : ""}${typeof recipient.status === "string" ? recipient.status : ""}`,
                },
              ],
              details: { recipient },
            },
            options.expanded,
            theme,
            {
              ...context,
              args: { name: typeof recipient.name === "string" ? recipient.name : "", message: context.args.message },
              isError: recipient.isError === true,
            },
          ),
        );
      }
      return container;
    },
  });
}
