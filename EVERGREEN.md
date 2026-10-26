## Summary
- Delegate asynchronously to separate Pi processes, with private context and durable named sessions.
- Completion and messages steer/wake the lead; resuming a worker spends no new launch slot.
- Pi touchpoints: extension tools/events, session persistence, CLI/RPC, providers, and terminal UI.
- Runtime uses no private Pi imports; SDK-loader tests use an internal loader path.
- Main risks: settlement ordering, cross-process admission/parking, ownership, and session reconstruction.

## Intent
Enable useful parallel work and context isolation without blocking the lead or leaking worker transcripts.
Names survive reloads; only direct parents may message or stop workers. Budgets cover the whole
nested tree, and a shared live-process cap queues work or parks waiting parents rather than deadlocking.
Stopping a subtree must neither kill siblings nor refund reserved delegation capacity.
Workers retain their original effective model, thinking level, settings, and saved conversation on resume.

## Pi integration (public APIs)
`index.ts` registers tools, commands, flags, lifecycle hooks, custom messages/renderers, and a recovery provider.
`sendMessage` steering and `agent_before_settle` keep completion delivery alive in print/JSON modes.
Session-manager entries/branches persist identities and budgets; `SessionManager` selects saved sessions.
Children use Pi CLI options and JSONL RPC prompt/steer, settlement, message, tool, and UI-status events.
Exported package/settings discovery APIs enforce child extension exclusions and project trust.
`pi-ai` provider helpers support recovery; `pi-tui` supplies widgets, key handling, and transcript overlays.
`agent_settled.aborted` stops subagent work after a main-agent abort; `registerShortcut("alt+w")`
provides a main-only abort exception scoped to that run. No raw terminal-input listener is installed.

## Internal Pi APIs
No private Pi imports, private object-field access, or monkey patches in runtime code.
Loader integration tests (including `evergreen-integration.test.ts`) resolve `core/extensions/loader.js`
relative to the SDK entry point; strict-schema tests also import `pi-ai/api/constrained-sampling.js`.
These internal test-only dependencies are sensitive to SDK layout changes.
The `subagent_background` JSON record/status-key convention is this extension's own worker protocol,
not a Pi RPC guarantee. Runtime also parses documented session JSONL and inherits CLI argument spelling.

## Weak points
Settlement versus queued steering can cause premature exit, lost completions, or duplicate continuation.
Broker persistence, process identity, FIFO admission, parking, cancellation, and PID cleanup must agree.
Saved branch selection, custom-message formats, owner tokens, and budget ledgers govern safe recovery.
Resource discovery/trust and CLI forwarding can change between Pi releases; filtering must fail closed.
Real model tests require credentials, network access, and tool-following; terminal themes need manual checks.

## Tests
`npm run test:evergreen` refreshes latest SDK packages, typechecks, runs all unit/integration tests,
then runs `test/e2e/evergreen.test.ts`. The runner uses a temporary checkout copy to prevent ancestor
`.pi` configuration contaminating fixtures, clears inherited delegation state, and bounds file concurrency.
`evergreen-integration.test.ts` loads the actual extension through Pi's loader, validates tool arguments,
and exercises launch → completion → reload → owned resume with an RPC peer (no model calls).
It protects durable ownership, foreign-owner denial, spent-budget preservation, and resume without new slots.
The e2e uses `$EVERGREEN_PI_BIN` (otherwise `pi` on PATH) and requires `$EVERGREEN_E2E_MODEL`.
It launches real lead/worker model calls, verifies asynchronous completion reaches the lead before exit,
then reopens the lead and asks the same worker to recall a deleted file from its saved session.
Sessions remain enabled; spawned lead Pi stdin is ignored. Auth/models are copied to a disposable agent dir.
Existing broker/tree tests protect caps and parking; stop/ownership/budget tests protect delegation boundaries.
Print-lifecycle, steering, recovery, usage, and render tests cover delivery, reconstruction, accounting, and UI.
Interrupt tests cover real worker cancellation and the run-scoped main-only shortcut. `interrupt-sdk.test.ts`
drives actual SDK abort/settlement events and a `sendCustomMessage` completion wake without a pending resume.
Alt+W matching is checked for legacy Meta and Kitty sequences; focused overlay handling remains Pi-owned.
Tested with global Pi 1.4.0 and latest 1.4.0 SDK packages; live interactive terminal behavior is not e2e-covered.

## Relevant changelog topics
Watch extension event ordering/settlement, queued steering, print/JSON keepalive, RPC framing and UI events;
session/custom-message schemas, branch reconstruction and resume flags; extension loading, package discovery
and project trust; model/provider registration and thinking selection; TUI widgets, key events, and rendering.
History anchors: async messaging (`5b22e77`), tree scheduling (`69a47f6`), custom-message recovery (`8c80006`),
print keepalive (`dcd786e`), and input interrupt guards (`7598587`).
