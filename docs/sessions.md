# Sessions and budgets

Workers run asynchronously. Budget reservations and lifetime descendant-cap semantics apply across launches, messages, and recovery.

## Async worker lifecycle

`subagents` returns `started` immediately and runs workers in the background. Each worker's completion arrives as steering to its lead and wakes the lead if idle. The launch acknowledgement is not a final result.

Workers keep durable names and saved sessions after completing a turn. `message_subagent(name, message, max_subagents_allowed?)` steers a running worker or resumes an idle worker with its saved context. It returns without waiting for completion. A running worker receives steering rather than a second concurrent turn on the same session. Set `name` to an array to contact several workers with one message. The registered schema uses arrays, including for one recipient; older single-name string calls are normalized automatically. Recipients receive only the message text. Failures are reported individually, and an optional allowance override applies separately to each recipient.

A child can call `message_lead_agent(message)` without blocking. The message becomes lead steering and wakes an idle lead. It does not finish the child's turn or wait for a reply. The lead replies through `message_subagent`.

`agent_settled` ends a worker's own turn, but does not finish its subtree while descendants remain active. The runner sends `Idle, waiting for children.` and the worker's own last answer to the lead via steering. It keeps the child process alive, pauses its idle watchdog, and lets descendant messages or completions wake it. `Finished` is reported only after the subtree and any resulting continuation have settled. This live idle state differs from a finished worker whose saved session can later be resumed.

Humans can use `/message_subagent` to select live targets, then enter a message. The choices are `All (+nested)`, `All`, `Youngest`, and `Names (e.g. John, Maria)`. There is no `No` choice; Esc cancels. This command steers live workers only. Automatic interception of ordinary user input for broadcast routing has been removed.

## Agent allowances

A new main session has 50 agent slots by default. Set `limits.total` in either settings filename or `PI_SUBAGENT_MAX_TOTAL_AGENTS` before starting a new session to change this. The environment takes precedence. `0` blocks new launches but permits named resumes. Invalid values block launches.

`max_subagents_allowed` caps all descendants a worker may launch, excluding the worker itself. Each task reserves `1 + max_subagents_allowed` slots from the caller. Two tasks with descendant caps of `3` and `0` reserve five slots. Use `0` for a direct worker; `1` lets the worker launch one subagent.

- Batch reservations are atomic across processes. If a batch exceeds the caller's remaining allowance, no task starts and no name is allocated.
- Siblings cannot borrow each other's slots. Unused, failed, or canceled reservations stay assigned to their branch for later resumes.
- Interrupted calls reuse their original reservations during recovery.
- Messaging or resuming a named worker consumes no new worker slot and retains its current allowance unless an override changes it.
- Workers with a positive descendant cap receive their remaining allowance in the prompt. Workers with a zero cap receive neither delegation tools nor added delegation guidance, but retain `message_lead_agent`. A higher cap supplied to `message_subagent` restores delegation tools, subject to the depth limit.

The main agent sees its remaining count only below 30, to avoid presenting larger caps as spending targets. Delegating workers see their branch allowance. Enforcement is the same regardless of prompt visibility.

Budgets persist across reloads, restarts, compaction, and forks. Changing the environment or JSON settings does not enlarge an existing tree. Workers from older sessions without recorded reservations may resume but cannot launch new descendants.

Older recorded calls and ledgers remain resumable. The extension converts their allowances to descendant caps without changing reserved or remaining slots. New calls use only `max_subagents_allowed`.

The ledger uses immutable files and atomic hard links beside saved worker sessions. Its filesystem must support hard links. Missing or corrupt state blocks launches instead of silently resetting the budget. Agent counts do not limit money spent or sandbox tool access.

## Changing a worker's budget

```json
{
  "name": "John",
  "message": "Continue the implementation",
  "max_subagents_allowed": 10
}
```

Pass this to `message_subagent` for either a running or idle worker. The override replaces the worker's lifetime descendant cap, excluding itself. It does not grant ten fresh launches. Omit it to retain the existing cap. Provider-generated `null` for this optional field also keeps the cap; explicit `0` still replaces it with zero.

- Increases reserve only additional capacity from the original launcher's allowance.
- Decreases cannot remove slots already spent or assigned. They do not refund the parent. Raising a cap to a previously funded value needs no new reservation.
- A caller can adjust workers in its own tree. For nested workers, increase the immediate launcher's cap first if needed.
- Each call targets one named worker. Its original launcher funds any increase, not the messaging caller's unrelated branch.
- Older workers without reservation records can resume without an override.
- Interrupted increases remain funded; retries do not charge twice.

## Names, ownership and forks

Each worker receives a unique name from a bundled list of 1,000 names. Names are not reused within a delegation tree. `message_subagent` targets one durable name per call; it has no batch-resume payload.

The shared name registry and ownership identity are recorded in session metadata. An ancestor-session lookup recovers identities from older sessions. This keeps names valid even when Pi assigns new session IDs after resume or branching.

The agent that launched a worker owns its original session. A child may receive an ancestor's worker name in its task. Messaging that name from another caller uses a private session fork, leaving the owner's context untouched. Each caller reuses one fork per name, including across restarts. Forks retain the same budget.

Only one turn runs on a worker session at a time. Messages to a running worker steer that turn; messages to an idle worker resume it. Session ownership checks and crash-tolerant registry markers prevent duplicate processes from opening the same transcript. Removed agent definitions do not prevent resume; the registry retains model/tool restrictions and the saved session retains context. Resumes open the saved transcript explicitly, preserving its original working directory even when the caller's directory differs. They do not use Pi's cwd-filtered `--continue` discovery. The runner selects that transcript once before extension discovery and uses its working directory for discovery and process startup. Caller approval applies only when that directory matches the caller's project; otherwise the saved project is explicitly unapproved, including when extension exclusions are disabled.

Relative `--skill`, `--prompt-template`, and theme file/directory arguments keep the parent's startup directory as their base, even when a resumed worker runs in another project. Named theme selections and non-filesystem references are forwarded unchanged.

## Crash recovery

Worker sessions live in `sessions-subagents`, beside Pi's normal `sessions` directory. Async recovery tracks outstanding workers durably on the active branch, even though their launch calls already returned `started`. On parent resume or session-tree navigation, recovery checks that work rather than waiting for an unfinished blocking tool call.

- Interactive mode asks whether to resume. Non-UI modes resume automatically.
- Finished siblings reuse their saved output and statistics without rerunning. Unfinished siblings continue their own sessions. Completion steering wakes an idle lead.
- Durable references retain output, usage, model, and tool counts across JSON/session restarts.
- Nested workers recover in the same way.
- Provider fallback preserves the selected model's effective provider, authentication, endpoints, headers, and environment.
- `/resume`, `/new`, `/fork`, and `/reload` discard pending recovery state and callbacks from the previous runtime.

Message acknowledgement is separate from worker completion. Recovery uses durable worker state rather than treating an acknowledged message as completed work. Retrying contact uses the same name without allocating a new worker or charging the same funded increase twice.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_SUBAGENT_RESUME_PROMPT` | `true` | `false` skips the interactive question and resumes automatically |
| `PI_SUBAGENT_DISABLE_RESUME` | `false` | `true` disables automatic crash recovery |
| `DISABLE_RESUMABLE_SUBAGENTS` | `false` | `true`, `on`, or `1` disables name allocation and named-worker messaging |
| `PI_SUBAGENT_NAMES_FILE` | Internal | Shared registry path, propagated to children |
| `PI_SUBAGENT_BUDGET_DIR` | Internal | Reserved branch ledger, propagated and saved in session metadata |

The recovery controls also have JSON settings: `resume.prompt`, `resume.disableAuto`, and `resume.disabled`, respectively. See [settings files](configuration.md#settings-files). Internal storage paths are managed by the extension and have no JSON counterpart.
