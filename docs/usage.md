# Usage accounting

## Result data

Delegation tool results include `details`. Recognize `subagents`, `resume_subagents`, and the legacy launch name `subagent` when reading old sessions.

The canonical interfaces live in [`types/contracts.ts`](../types/contracts.ts). Avoid maintaining a separate copy of those interfaces.

Live results contain:

| Field | Meaning |
| --- | --- |
| `mode` | `single` or `parallel` |
| `delegationMode` | `spawn`, retained for serialization compatibility |
| `results` | Direct worker results, including messages, own usage, tool counts, outcome, and identity |
| `aggregatedUsage` | Own and descendant token counts and cost |
| `aggregatedToolCalls` | Own and descendant tool counts |
| `usageTree` | Recursive per-worker breakdown |

`SingleResult.usage` and `.toolCalls` cover only that worker. A child's tokens never appear in its parent's own model usage. Tool counts include delegation calls themselves.

`contextTokens` is the last context-window snapshot, not cumulative usage. It is not summed across agents. Cost is in USD.

Saved parent-session results use compact schema version 3. They omit full worker transcripts and recursive live breakdowns. Instead, `usageSummary` holds the recursive totals and `results` holds durable child references with outcome and recovery data. Do not assume that saved results contain live `messages`, `usageTree`, or aggregate tool counts.

## Reading RPC events

Current Pi emits tool results as `message_end` events with `message.role === "toolResult"`. Older streams may use `tool_result_end`. Process each tool call only once if a transport delivers both shapes.

```js
const seen = new Set();
let costUsd = 0;

for await (const line of jsonLines) {
  const event = JSON.parse(line);
  const message = event.message;
  if (!["message_end", "tool_result_end"].includes(event.type)) continue;
  if (message?.role !== "toolResult") continue;
  if (!["subagents", "subagent", "resume_subagents"].includes(message.toolName)) continue;
  if (!message.details || seen.has(message.toolCallId)) continue;
  seen.add(message.toolCallId);

  const details = message.details;
  costUsd += details.usageSummary?.costUsd ?? details.aggregatedUsage?.cost ?? 0;
}
```

This sums one parent stream. Do not also sum its children's streams, since parent delegation totals already include descendants. Parent-only model usage can be added separately.

## Interactive footer

The `WITH SUBS` line includes the parent's billed session entries and recursive worker usage. Parent accounting follows Pi's session-statistics rules using `ctx.sessionManager.getEntries()`, including off-branch retries, compacted history, branch summaries, and tool-reported usage. Durable worker summaries add delegated cost once.

The worker count tracks unique identities, not invocations. Named resumes and private forks add usage without increasing the count. Older compact history can recover identities from the name registry.

Pi renders this extension's combined usage through its normal `ctx.ui.setStatus()` footer line.
