# Async performance and memory review

This review covers the implemented async execution, progress transport, accounting, routing caches, live UI, and lifecycle cleanup. The tests measure bookkeeping work and retained data, not production throughput or process scaling.

## Changes

- Async reconciliation merges all completions into a launch before rebuilding its summary. Recovery lookup indexes successful completions by session, task, and execution start instead of copying and reversing the completion list for every unfinished worker. Batch accounting unions identity sets once instead of repeatedly copying a growing list.
- Footer accounting scans only newly appended session entries after checking the previous tail by reference. Parent-only appends reuse delegated totals. New durable completions still reconcile against earlier launches. Reloaded or shortened histories rebuild the cache. Switching files on the same session manager also invalidates it, even when the leaf ID matches. Totals still include off-branch entries, compactions, tool usage, and resumed executions.
- Live accounting indexes delegation messages separately from ordinary transcript messages. Final-output lookup examines only newly appended finalized messages. Both caches use weak history keys. Finalized messages must remain immutable; replacing the history array is supported, but mutating earlier messages in place is not a supported cache invalidation mechanism.
- Async batches release each completed worker's transcript before waiting for slower siblings. They retain full final output, failure explanations, own usage, subtree usage, and recovery references. Canonical summaries and non-enumerable compatibility usage totals retain descendant charges. The completion callback receives the original result before release. Synchronous runner callers keep their existing transcript behavior unless they opt into `compactCompletedResults`.
- Async per-worker updates no longer build a usage tree just to replace one batch slot. Calls without a progress observer construct no per-event details. The existing batch throttle still controls tree snapshots; all independent jobs now also share a 100 ms footer refresh throttle. Accounting updates happen immediately, not on that timer.
- Nested progress retains async job/task identities and custom completion details. This fixes partial-sibling accounting at ancestors. Finalized message projections use weak keys. Progress skips serialization while stdout needs draining, rather than accumulating transient snapshots behind a blocked protocol pipe. A later heartbeat retries; durable messages and completion delivery do not use this drop policy.
- Protocol activity detection retains one fixed-size digest per nested call, not a serialized tree. Unchanged snapshots from interleaved siblings no longer reset the semantic watchdog. Resolved attempts ignore late protocol records. Progress callbacks also reject old lifecycle generations before touching accounting or UI callbacks.
- Completion reservations maintain their current-generation count without scanning the pending map for every reserve/release. An old same-key background job cannot delete its replacement's accounting. Completed jobs leave the registry after cleanup.
- Async owners enable `cancelOnError`. Infrastructure failures cancel and drain sibling subprocesses before background tracking disappears. A throwing handle callback now terminates its child. Attempt settlement destroys its streams and removes its abort listener; existing timeout and steering cleanup remains in place. Disposed progress coalescers release their callback reference.
- Repeated completion text no longer causes the message index to discard a different execution's durable accounting. Completion publication retains stderr-only failure explanations without retaining the original transcript in its delivery callback.

### Routing and UI caches

- Automatic broadcast interception of ordinary user input has been removed. The human `/message_subagent` command chooses live targets first, then asks for a message. Its choices are `All (+nested)`, `All`, `Youngest`, and `Names (e.g. John, Maria)`. There is no `No` choice; Esc cancels.
- Routing snapshots are cached per live root. A progress update visits only the roots it reports, using an incremental nested-message index. Flattening, fallback discovery, and sorting happen lazily when target arrays are read, not on every independent job's progress update. Unchanged reads reuse the flattened arrays. Reads validate handle identity and lifecycle generation, so same-count replacements and completed roots do not retain old descendants.
- The above-editor widget renders one line of running names and elapsed times, with `+N` overflow and an idle count. It reads only live handles and snapshots, never session metadata or disk on its ticks. Activity changes coalesce at 250 ms; a one-second elapsed-time interval runs only while live entries exist. Session restart and shutdown dispose the widget, callback, queued refresh, and interval.
- `/subagent-expand` lists running workers by depth, top levels before nested workers, then live idle parents waiting for children, then completed or stopped history. Registry reads reuse parsed data while the file path, lifecycle generation, mtime, and size match. Autocomplete does not load transcripts.
- Parsed transcript details use a separate eight-entry LRU per open overlay. Record metadata, selected session directory, file lists, mtimes, and sizes invalidate entries, including when a private fork appears. Closing the overlay clears its details and refresh timer; stale lifecycle generations close it rather than showing the previous session.
- At `agent_settled`, a worker with active descendants reports `Idle, waiting for children.` and its own last answer to its lead via steering. The process remains alive with its idle watchdog paused. Final `Finished` status waits for the whole subtree and any continuation to settle.

The durable schema remains version 3. No new cache or progress history is serialized into sessions. Completion output remains complete, rather than silently truncated to meet a metadata size limit.

## Evidence

The regression tests use operation counts and observable retained data rather than elapsed-time thresholds:

| Case                                           | Assertion                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1,000 completions for one launch               | 1,000 worker usage reads during reconciliation, not a batch rebuild after each completion        |
| 1,000 parent entry appends                     | Each assistant usage is read only for its own append; replacing the cached tail forces a rebuild |
| Parent-only conversation after delegation      | Previously recorded delegated details are not revisited                                          |
| 1,000 live transcript appends                  | Only the new message is inspected by the delegation index and output lookup                      |
| 1,000 independent progress producers           | One immediate footer refresh, one trailing refresh, one scheduled timer                          |
| 1,000 delivery reservations and releases       | One initial pending-map scan                                                                     |
| 1,000 progress attempts against a blocked pipe | No snapshot projection or write                                                                  |
| Fast worker with a running sibling             | Finished transcript is empty while output and subtree accounting remain available                |
| Infrastructure callback failure                | Both subprocess lifecycles settle before the async batch rejects                                 |
| Nested async completion forwarding             | Accounting matches before and after JSON projection, including unfinished siblings               |
| 1,000 independent routing updates              | One handle lookup per reported root; no global active-map traversal or sorting during updates     |
| Repeated routing reads                         | Unchanged reads reuse sorted arrays; replacements and completion prune stale targets              |
| Registry and detail navigation                  | Unchanged files reuse parses; changed files invalidate; overlay detail LRU retains eight entries   |
| Live widget and overlay disposal               | Refreshes coalesce; timers and callbacks stop on disposal or session lifecycle changes             |

Run the focused tests from the repository root:

```sh
mkdir -p tmp
TMPDIR="$PWD/tmp" node --import tsx/esm --test \
  test/async-scaling*.test.ts test/broadcast-cache.test.ts \
  test/expand-cache.test.ts test/expand-command-cache.test.ts \
  test/activity-widget.test.ts test/expand-activity-order.test.ts
```

When running the full suite from inside a subagent, remove inherited delegation identity and budget variables in that shell first. Otherwise root-session fixtures can pick up the caller's registry, depth, and allowance. For Bash:

```sh
unset "${!PI_SUBAGENT_@}"
TMPDIR="$PWD/tmp" npm test
```

The 1,000-item cases exercise bookkeeping only. Small real subprocess fixtures test lifecycle behavior. Neither establishes throughput for 1,000 simultaneous Pi processes or production scaling.

## Remaining limits

- Every running agent is a separate Pi/Node process. Concurrency defaults to eight **per call**, not across all independent async jobs. Raising per-call limits or issuing many calls can still exhaust RAM, file descriptors, provider limits, or CPU. There is no new global process scheduler in this change.
- Pi's `SessionManager.getEntries()` filters the entire session into a defensive array. Leaf changes still incur that shallow copy. New durable delegation messages also trigger reconciliation of earlier relevant launch/completion messages. A long sequence of individually consumed completions can therefore still have quadratic cumulative reconciliation work. This review does not claim linear end-to-end session processing.
- `types/usage.ts` and `types/details.ts` still rebuild legacy usage trees and identity arrays in general-purpose durable builders. Their final-batch work is separate from the corrected per-completion reconciliation path. Legacy nested transcripts can require recursive traversal. New schema-v3 results do not embed those transcripts.
- Routing progress updates no longer flatten and sort all jobs. They still traverse changed roots' relevant nested results. A target-array read validates active roots, and an invalidated read flattens and sorts the current targets. This shifts global work to consumers; it does not eliminate it.
- Opening a selected worker still loads and parses its full transcript files on a detail-cache miss or invalidation. The eight-entry overlay LRU limits retained detail count, not bytes per transcript. Overlay refreshes still stat the registry, and detail validation stats session files. Existing render ordering caches are bounded at 500 entries and cleared on session lifecycle changes.
- Running transcripts, message-index entries, final answers, and exact execution/agent identity sets grow with the work they represent. The caches use weak ownership, not arbitrary LRU eviction that could lose duplicate detection or accounting. Finished async transcripts are released, but active histories, active output, final answers, and required accounting identities remain unbounded.
- An incomplete stdout JSONL record can still grow inside `JsonlFramer` until it terminates or the attempt stops. Valid records and final outputs also have no byte limit. Adding a limit needs an explicit oversize-record policy; silently clipping them would lose output or usage data. Stderr and live logs already have bounds.
- A successful completion send retains its delivery token until the matching custom message starts, or the session lifecycle clears it. A queued message that is never consumed can keep a child waiting and retain a small token. No TTL was added: guessing that delivery happened would let the parent reap a child before its continuation runs. One delivery timer per completion is still scheduled; the new shared throttle only covers progress footer refreshes.
- The SDK runner retains its earlier failure behavior unless `cancelOnError` is enabled. The extension's async execution path enables it. Custom background implementations that ignore abort signals or never finish cleanup can still prevent shutdown from completing.
