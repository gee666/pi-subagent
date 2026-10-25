# Usage accounting

## Async acknowledgements and completion

`subagents` returns immediately with `started` or `queued` status, before final output or usage is available. Each call accepts up to 20 tasks by default. The root session creates a shared cross-process FIFO queue and a concurrency cap of 8 by default. Descendants inherit both; nested workers cannot loosen the cap. All live worker processes across the tree count. Parked parents have saved context and exited, so they no longer occupy slots. Queued workers start as capacity becomes available. The root's `/subagent:max-concurency` command changes the shared cap for this session only.

Waiting parents park to let queued descendants run without exceeding the cap. Parking saves context and exits the actual parent process. The root broker retains child process descriptors and queued work. Parent wakes have lower priority than queued children, but spare capacity can wake parents before all children finish.

`message_subagent(name, message, max_subagents_allowed?)` also returns without waiting for the worker to finish. Steering an existing running worker takes no new concurrency slot. Resuming a saved idle durable named worker uses the tree-global queue and waits when the cap is full. A parent still alive while waiting for children already occupies a slot. Manual messages to parked parents fail. A child's `message_lead_agent` also fails while its immediate parent is parked. Wait for automatic parent resume. Neither acknowledgement is a completed worker result.

`message_subagent` and `stop_subagent` accept only the caller's own direct children. Both saved owner identity and backend parent token must match; grandchildren, siblings, and foreign saved workers are rejected. `stop_subagent` accepts one direct child's name or an array of names. It stops each named worker's entire subtree, killing live descendants and canceling queued descendants and resumes before they start. Stopping releases occupied concurrency capacity, but does not refund reserved worker or descendant budget slots. Explicit stops are recorded silently without a redundant failure notification or parent wake-up; their usage still counts.

Completion arrives separately as lead steering and wakes an idle lead. A child's nonblocking `message_lead_agent(message)` also sends lead steering, but is not a completion event. Do not count a progress report, question, or launch acknowledgement as final usage.

Completion is a custom message with `customType: "subagent_completion"`, display text in `content`, and result data in `details`. Normal completions use `deliverAs: "steer"` with `triggerTurn: true`. Explicit-stop records are hidden, do not trigger a turn, and are excluded from model context. Launch receipts carry `asyncJobId`; individual completions carry that ID and `asyncTaskIndex` to identify the launch slot. Results also retain durable worker and execution identities. Include each execution once, even after recovery or repeated delivery. Final statistics do not belong to the launch acknowledgement.

A worker that settles while descendants remain active sends `Idle, waiting for children.` and its own last answer as ordinary lead steering. That is not a final completion or a final usage total. If parked, the parent saves context and exits while the root broker preserves child execution. `Finished` still waits for subtree settlement.

In the interactive TUI, press Escape to interrupt the main agent and stop all running, queued, and parked subagent work, including detached descendants. This also works while the main agent is idle. Explicitly stopped workers do not automatically resume; their usage and spent budget still count. Escape keeps its normal behavior when there is no subagent work.

Do not run Bash `sleep` or polling loops while waiting for workers. Do other work, or end the turn and wait for completion steering. Keep the session open. When the lead is idle with running, queued, or parked work pending, the TUI shows an animated `Waiting for subagents - don't close the session` line above `Running N`. It disappears when the lead becomes busy or all worker work finishes; Pi's native `Working` indicator is unchanged.

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

## Interactive usage widget

The `WITH SUBS` line includes the parent's billed session entries and recursive worker usage. Parent accounting follows Pi's session-statistics rules using `ctx.sessionManager.getEntries()`, including off-branch retries, compacted history, branch summaries, and tool-reported usage. Durable worker summaries add delegated cost once. Async delivery retains this accounting across idle periods and recovery.

The worker count tracks unique identities, not invocations. Messaging and named resumes add usage without increasing the count. Older compact history can recover identities from the name registry. This usage count is separate from budget reservations: launching reserves `1 + max_subagents_allowed` slots, including for queued launches, while messaging an existing worker allocates no new budget slot. A resumed idle worker still needs concurrency capacity. A cap increase can reserve additional descendant capacity from its original launcher.

Pi renders combined usage as a single dim widget line below the editor, clipped to the terminal width. It appears only after at least one worker has been used, including workers recovered from a saved session, and stays visible after workers finish. Empty sessions and sessions with only parent usage show no usage widget. The extension does not add this summary to the status footer. This is separate from the live `Running N` line above the editor, which shows names, elapsed times, overflow, and idle count using live handles and snapshots without session metadata or disk reads on ticks.

The main `index.ts` entry retains its default registration export and named exports `selectParentModelForSubagent`, `getSubagentsToolDescription`, `collectCombinedUsageStatusLine`, and `collectLiveUsageSummary`. Existing root entry-point imports remain supported.
