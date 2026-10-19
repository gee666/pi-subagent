# Usage accounting

## Async acknowledgements and completion

`subagents` returns `started` immediately, before final output or usage is available. `message_subagent(name, message, max_subagents_allowed?)` also returns without waiting for the worker to finish. It steers a running worker or resumes an idle durable named worker. Neither acknowledgement is a completed worker result.

Completion arrives separately as lead steering and wakes an idle lead. A child's nonblocking `message_lead_agent(message)` also sends lead steering, but is not a completion event. Do not count a progress report, question, or launch acknowledgement as final usage.

Completion is a custom message with `customType: "subagent_completion"`, display text in `content`, and result data in `details`. It uses `deliverAs: "steer"` with `triggerTurn: true`. Launch receipts carry `asyncJobId`; individual completions carry that ID and `asyncTaskIndex` to identify the launch slot. Results also retain durable worker and execution identities. Include each execution once, even after recovery or repeated delivery. Final statistics do not belong to the launch acknowledgement.

A worker that settles while descendants remain active sends `Idle, waiting for children.` and its own last answer as ordinary lead steering. That is not a final completion or a final usage total. The process remains alive; `Finished` waits for subtree settlement.

## Result data

Result and saved-session interfaces live in [`types/contracts.ts`](../types/contracts.ts). Async identity and reconciliation helpers live in [`types/messages.ts`](../types/messages.ts), re-exported through `types.ts`. Use these definitions rather than maintaining separate copies.

Live result details contain:

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

Saved parent-session results use compact schema version 3. They omit full worker transcripts and recursive live breakdowns. Instead, `usageSummary` holds the recursive totals and `results` holds durable child references with outcome and recovery data. Do not assume that saved results contain live `messages`, `usageTree`, or aggregate tool counts. Async completion preserves durable usage accounting without requiring full worker transcripts in the lead's context.

## Reading RPC events

Pi emits tool results as `message_end` events with `message.role === "toolResult"`. Older streams may use `tool_result_end`. Process each tool call only once if a transport delivers both shapes.

A tool-result-only cost accumulator misses async completions. Launch and messaging tool results acknowledge work; completion steering carries the later outcome. Decode custom messages with `customType === SUBAGENT_COMPLETION_TYPE`, whose value is `subagent_completion`, and validate their `details` with `isSubagentDetails`. Ordinary child-to-lead messages, including idle notifications, are not completion usage.

`getNestedSubagentResults(messages)` reconciles launch placeholders with individual completions. `asyncJobId(details)` reads the launch identity and `subagentExecutionId(result)` reads the execution identity. These helpers and `SUBAGENT_COMPLETION_TYPE` are exported from `types.ts`. Match a completion to its job and task slot rather than adding the launch placeholder and completion as separate runs.

Sum one lead stream's recursive worker totals. Do not also sum its children's streams, since recursive totals already include descendants. Lead-only model usage can be added separately. Repeated completions or overlapping summaries must not add the same worker run twice.

## Interactive footer

The `WITH SUBS` line includes the parent's billed session entries and recursive worker usage. Parent accounting follows Pi's session-statistics rules using `ctx.sessionManager.getEntries()`, including off-branch retries, compacted history, branch summaries, and tool-reported usage. Durable worker summaries add delegated cost once. Async delivery retains this accounting across idle periods and recovery.

The worker count tracks unique identities, not invocations. Messaging, named resumes, and private forks add usage without increasing the count. Older compact history can recover identities from the name registry. This usage count is separate from budget reservations: launching reserves `1 + max_subagents_allowed` slots, while messaging an existing worker allocates no new worker slot. A cap increase can reserve additional descendant capacity from its original launcher.

Pi renders this extension's combined usage through its normal `ctx.ui.setStatus()` footer line. This is separate from the live `Running N` line above the editor, which shows names, elapsed times, overflow, and idle count using live handles and snapshots without session metadata or disk reads on ticks.

The main `index.ts` entry retains its default registration export and named exports `selectParentModelForSubagent`, `getSubagentsToolDescription`, `collectCombinedUsageStatusLine`, and `collectLiveUsageSummary`. Existing root entry-point imports remain supported.
