# Main-process CPU audit

This audit found reproducible excess work in the extension. It does not establish what saturated the reported Pi process. No CPU profile of that process was captured.

## Fixed

### Message deduplication

`runner/events.ts` previously serialized each earlier message while checking every new message. For N distinct messages without IDs, it computed N × (N + 1) / 2 equality keys. Tool output and thinking content made those keys expensive.

`runner/message-index.ts` now indexes finalized messages by SHA256 fingerprint. Each distinct message is serialized once. Matching fingerprints still receive an exact comparison, preserving the existing equality rules. A weak reference to the history owns the index, and serialized transcript copies are not retained.

The index assumes finalized messages remain immutable and histories are append-only. New arrays and shortened arrays are reindexed. Replacing an existing array element in place is not supported.

`test/message-dedup-index.test.ts` verifies that 200 resumed messages plus 400 new messages require 600 serializations, not repeated scans of the history. It also covers legacy events, equality compatibility, usage accounting and nested-progress cleanup.

### Fragmented stdout records

`runner/attempt.ts` previously appended each stdout chunk to a buffer and split the entire buffer on every arrival. A large JSON record arriving in small chunks repeatedly scanned and copied the accumulated prefix.

`runner/jsonl-framer.ts` now scans only newly decoded fragments and joins them when a complete record arrives. Tests cover fragmented UTF-8, CRLF, Unicode separators inside JSON, multiple records, and unterminated final records. The scan-count test checks linear growth for a 2 MiB record.

A single record still requires memory proportional to its size, and `JSON.parse` still runs synchronously. This patch does not impose a new record-size limit.

### Batch progress updates

`runner/parallel.ts` previously built and forwarded a whole-batch snapshot on every child update. Nested progress then repeated usage aggregation, serialization and rendering at each ancestor.

`runner/progress-coalescer.ts` now limits routine batch updates to one per 100 ms. Incoming results update immediately; snapshot construction waits until emission. Initial progress is immediate, heartbeats share the limiter, and completion flushes pending state. Abort and failure cancel queued callbacks.

Tests cover bursts, simultaneous siblings, final flushing, heartbeat behavior, abort, failure and late sibling updates. A two-child integration test sends 200 message events without constructing a batch snapshot for each event.

### Progress payloads

`extension/progress-details.ts` now constructs an explicit wire projection rather than spreading full results and messages. It excludes ordinary transcript messages, tool-result bodies, arbitrary metadata, active-tool arguments, and recursive usage trees. Completed delegation results retain only the structure needed for tree rendering and accounting.

Activity logs retain at most six entries. Tool arguments include only bounded display fields such as command, path or pattern, never write content or edit replacements. Individual argument strings are capped at 256 characters; error previews at 1,000 characters. Completed output previews use at most the final 2,048 characters, reduced to six lines of at most 240 characters each. Running output text is omitted.

Task text, call IDs, names and usage identities remain exact because current consumers use them for structural matching, accounting and steering. No descendant-count or tree-depth cap is introduced. These changes reduce repeated payloads; they do not impose a hard record-size limit.

The projection accepts compact saved details with no message array. Full final results, saved transcripts and resume data are unchanged. Pi's own `message_end` and `agent_end` records can still contain large messages; this patch only controls the extension's `subagent_progress` records.

Payload tests verify that growing discarded data to two million characters does not increase progress size, that previews are bounded, and that projection does not mutate source data. Compatibility tests cover trees, legacy calls, signature fallback, usage, identities, steering paths and compact saved results.

## Remaining work

Profile a long-running, nested workload before expanding this patch. In particular:

- `runner/single.ts` still builds each child's live details for every accepted semantic event. Batch coalescing limits downstream work, not this per-child cost.
- Progress still recursively projects the structural tree, and `runner/protocol.ts` serializes that projection again to detect changes. Large delegation trees and long task prompts can remain expensive even after body payloads are removed.
- `render.ts` builds tree nodes on repeated collapsed renders, and `ui/tree-build.ts` scans histories to build nested children and previews. Consider width/content caching with correct invalidation if a profile attributes substantial CPU here.
- `runner/attempt.ts` clears and allocates an inactivity timer on each streaming delta. A mutable deadline and one timer would avoid that churn, but must preserve retry grace and active-tool exemptions.
- Session header/settings reads load whole transcripts. Registry and budget operations use synchronous filesystem work. These can block the event loop, though disk waits alone do not explain sustained CPU saturation.

For a follow-up measurement, record parent-process CPU and event-loop delay with representative transcript sizes and nesting. Compare progress enabled and disabled, and interactive and non-interactive runs. Capture a Node CPU profile of the parent to distinguish JSON processing, tree rendering and filesystem work from Pi's own costs.

## Validation

`npm run check` passed after the changes: TypeScript, formatting, file-size checks and all 447 tests. These regression checks demonstrate reduced repeated work; they are not a production CPU measurement.
