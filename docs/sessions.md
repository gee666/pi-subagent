# Sessions and budgets

## Agent allowances

A new main session has 50 agent slots by default. Set `PI_SUBAGENT_MAX_TOTAL_AGENTS` before starting a new session to change this. `0` blocks new launches but permits named resumes. Invalid values block launches.

`max_subagents_allowed` caps all descendants a worker may launch, excluding the worker itself. Each task reserves `1 + max_subagents_allowed` slots from the caller. Two tasks with descendant caps of `3` and `0` reserve five slots. Use `0` for a direct worker; `1` lets the worker launch one subagent.

- Batch reservations are atomic across processes. If a batch exceeds the caller's remaining allowance, no task starts and no name is allocated.
- Siblings cannot borrow each other's slots. Unused, failed, or canceled reservations stay assigned to their branch for later resumes.
- Interrupted calls reuse their original reservations during recovery.
- Named resumes consume no new slots and retain the worker's current allowance.
- Workers with a positive descendant cap receive their remaining allowance in the prompt. Workers with a zero cap receive neither delegation tools nor added delegation guidance. A higher cap on resume restores the tools, subject to the depth limit.

The main agent sees its remaining count only below 30, to avoid presenting larger caps as spending targets. Delegating workers see their branch allowance. Enforcement is the same regardless of prompt visibility.

Budgets persist across reloads, restarts, compaction, and forks. Changing the environment does not enlarge an existing tree. Workers from older sessions without recorded reservations may resume but cannot launch new descendants.

Older recorded calls and ledgers remain resumable. The extension converts their allowances to descendant caps without changing reserved or remaining slots. New calls use only `max_subagents_allowed`.

The ledger uses immutable files and atomic hard links beside saved worker sessions. Its filesystem must support hard links. Missing or corrupt state blocks launches instead of silently resetting the budget. Agent counts do not limit money spent or sandbox tool access.

## Changing a worker's budget

```json
{
  "resumes": [
    { "subagent": "John", "task": "Continue the implementation", "max_subagents_allowed": 10 }
  ]
}
```

The override replaces the worker's lifetime descendant cap, excluding itself. It does not grant ten fresh launches. Omit it to retain the existing cap.

- Increases reserve only additional capacity from the original launcher's allowance.
- Decreases cannot remove slots already spent or assigned. They do not refund the parent. Raising a cap to a previously funded value needs no new reservation.
- A caller can adjust workers in its own tree. For nested workers, increase the immediate launcher's cap first if needed.
- Overrides in one call must share an original launcher. Split different launchers into separate calls.
- Older workers without reservation records can resume without an override.
- Interrupted increases remain funded; retries do not charge twice.

## Names, ownership and forks

Each worker receives a unique name from a bundled list of 1,000 names. Names are not reused within a delegation tree. All entries in `resume_subagents.resumes` run in parallel. The single-entry shorthand `{"subagent":"John","task":"Continue"}` remains accepted.

The shared name registry and ownership identity are recorded in session metadata. An ancestor-session lookup recovers identities from older sessions. This keeps names valid even when Pi assigns new session IDs after resume or branching.

The agent that launched a worker owns its original session. A child may receive an ancestor's worker name in its task. Resuming that name creates a private session fork, leaving the owner's context untouched. Each caller reuses one fork per name, including across restarts. Forks retain the same budget.

Concurrent resumes of the same session are rejected using both in-process checks and crash-tolerant registry markers. Removed agent definitions do not prevent resume; the registry retains model/tool restrictions and the saved session retains context.

## Crash recovery

Worker sessions live in `sessions-subagents`, beside Pi's normal `sessions` directory. On parent resume or session-tree navigation, the extension checks for an unfinished `subagents` call on the active branch.

- Interactive mode asks whether to resume. Non-UI modes resume automatically.
- Finished siblings reuse their saved output and statistics. Unfinished siblings continue their own sessions.
- Durable references retain output, usage, model, and tool counts across JSON/session restarts.
- Nested workers recover in the same way.
- Provider fallback preserves the selected model's effective provider, authentication, endpoints, headers, and environment.
- `/resume`, `/new`, `/fork`, and `/reload` discard pending recovery state and callbacks from the previous runtime.

Interrupted `resume_subagents` calls are not replayed automatically. The model can issue them again using the same names.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_SUBAGENT_RESUME_PROMPT` | `true` | `false` skips the interactive question and resumes automatically |
| `PI_SUBAGENT_DISABLE_RESUME` | `false` | `true` disables automatic crash recovery |
| `DISABLE_RESUMABLE_SUBAGENTS` | `false` | `true`, `on`, or `1` disables name allocation and the named-resume tool |
| `PI_SUBAGENT_NAMES_FILE` | Internal | Shared registry path, propagated to children |
| `PI_SUBAGENT_BUDGET_DIR` | Internal | Reserved branch ledger, propagated and saved in session metadata |

Internal storage paths should normally be left to the extension.
