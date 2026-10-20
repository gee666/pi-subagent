# Configuration

Launch and messaging tools acknowledge work without waiting for completion. The settings below control delegation, saved sessions, and worker processes.

## Agent frontmatter

| Field | Default | Meaning |
| --- | --- | --- |
| `name` | Required | Identifier used by `subagents` |
| `description` | Required | Description shown to the parent |
| `model` | Parent's active model | Legacy fallback when live parent context is unavailable |
| `thinking` | Pi default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `tools` | `read,bash,edit,write` | Comma-separated built-in tools |
| `first-layer` | `enabled` | Rule for depth 1 |
| `second-layer` | `enabled` | Rule for depth 2 |
| `last-layer` | `enabled` | Rule for the configured maximum depth |
| `nth-layer(1,2,-1)` | `enabled` | Rule for listed depths |

Layer rules accept:

- `enabled`: leaves these layers available without overriding other rules.
- `disabled`: excludes these layers, even if another rule permits them.
- `only`: restricts availability to these layers. Multiple `only` rules combine.

Depth 1 is the first child of the main agent. Negative selectors count from the maximum depth, so `-1` is the last layer. Out-of-range numbers match nothing. Zero, fractions, malformed selectors, and invalid values produce warnings and are ignored.

```yaml
# Main-agent launches only.
first-layer: only
```

```yaml
# At maximum depth 8, permits layers 1, 4, 5 and 8.
nth-layer(1,2,5,-1,-5): only
second-layer: disabled
```

At maximum depth 1, combining `first-layer: only` with `last-layer: disabled` blocks all launches of that definition.

## Settings files

`pi-subagent.json` and `pi-subagents.json` are both permanently supported filenames with the same format. Either name works at each location below:

1. `~/.pi/`
2. `$PI_CODING_AGENT_DIR/`, normally `~/.pi/agent/`
3. The nearest trusted project `.pi/` containing either filename, walking upward from the working directory

Later locations override earlier ones per setting. If both filenames exist at one location, only `pi-subagent.json` is read there. Use either name; no migration is needed.

For each setting, an explicitly set environment variable wins over JSON, then the built-in default applies. Empty or invalid environment values still take precedence and use that variable's existing parsing rules. Explicit `false`, `0`, and empty arrays in JSON are not treated as missing. CLI delegation flags retain their existing priority; children cannot loosen inherited delegation limits. Existing session budgets are not reset by configuration changes.

```json
{
  "extension": { "disabled": false, "exclude": [] },
  "agents": { "confirmProject": "ask" },
  "limits": { "total": 50, "tasksPerCall": 20, "concurrency": 8 },
  "delegation": { "depth": 3, "preventCycles": true },
  "resume": { "disableAuto": false, "prompt": true },
  "models": { "intelligence": true },
  "runner": {
    "startupTimeoutMs": 120000,
    "idleTimeoutMs": 1200000,
    "startupRetries": 2
  }
}
```

| JSON setting | Environment variable | Default |
| --- | --- | --- |
| `extension.disabled` | `PI_SUBAGENT_DISABLED` / `PI-SUBAGENT-DISABLED` | `false` |
| `extension.exclude` | `PI_SUBAGENT_EXCLUDE_EXTENSIONS` / `PI-SUBAGENT-EXCLUDE-EXTENSIONS` | `[]` |
| `agents.confirmProject` | `PI_SUBAGENT_CONFIRM_PROJECT_AGENTS` | `"ask"` |
| `limits.total` | `PI_SUBAGENT_MAX_TOTAL_AGENTS` | `50` |
| `limits.tasksPerCall` | `PI_SUBAGENT_MAX_TASKS_PER_CALL` | `20` |
| `limits.concurrency` | `PI_SUBAGENT_MAX_CONCURRENCY` | `8` |
| `delegation.depth` | `PI_SUBAGENT_MAX_DEPTH` | `3` |
| `delegation.preventCycles` | `PI_SUBAGENT_PREVENT_CYCLES` | `true` |
| `resume.disableAuto` | `PI_SUBAGENT_DISABLE_RESUME` | `false` |
| `resume.prompt` | `PI_SUBAGENT_RESUME_PROMPT` | `true` |
| `models.intelligence` | `PI_SUBAGENT_INTELLIGENCE` | `true` |
| `models.fallback` | `PI_SUBAGENT_FALLBACK_MODEL` | No configured fallback |
| `runner.startupTimeoutMs` | `PI_SUBAGENT_STARTUP_TIMEOUT` | `120000` |
| `runner.idleTimeoutMs` | `PI_SUBAGENT_IDLE_TIMEOUT` | `1200000` |
| `runner.startupRetries` | `PI_SUBAGENT_STARTUP_RETRIES` | `2` |
| `runner.command` | `PI_SUBAGENT_PI_COMMAND` | Current runtime |
| `runner.argsPrefix` | `PI_SUBAGENT_PI_ARGS_PREFIX` | Current entrypoint |

JSON switches require booleans; counts and timeouts require non-negative safe integers. `agents.confirmProject` accepts `true`, `false`, `"ask"`, `"never"`, or `"session"`. `models.fallback` and `runner.command` accept non-empty strings. `extension.exclude` and `runner.argsPrefix` accept arrays of strings. Invalid settings warn and are ignored, except an invalid `limits.total` blocks new launches.

`extension.exclude` entries follow the matching rules in the README. JSON arrays preserve commas inside paths. Setting either environment alias replaces the JSON list; when both aliases are set, their CSV lists combine. Either disabling alias set to `1` or `true` disables the extension, regardless of JSON.

`runner.command` and `runner.argsPrefix` are personal-only settings. Project files cannot change the executable or its startup arguments, even in trusted projects. The prefix applies only with an explicit command. For example, a personal file can contain `"runner": { "command": "node", "argsPrefix": ["/absolute/path/to/pi.js"] }`.

JSON `extension.disabled` disables session features after project settings resolve, so a trusted project can override a personal value. Environment disabling prevents registration altogether. Reload Pi after changing settings.

Only user-configurable extension variables have JSON counterparts. Inherited runtime metadata stays internal: `PI_SUBAGENT_DEPTH`, `PI_SUBAGENT_STACK`, `PI_SUBAGENT_BUDGET_DIR`, `PI_SUBAGENT_NAMES_FILE`, `PI_SUBAGENT_SESSION_ROOT`, `PI_SUBAGENT_RUN_INTELLIGENCE`, `PI_SUBAGENT_CONCURRENCY_DIR`, `PI_SUBAGENT_WORKER_TOKEN`, `PI_SUBAGENT_BROKER_DIR`, and `PI_SUBAGENT_BROKER_SECRET`. OS and Pi SDK variables such as `HOME`, `PATH`, `PI_CODING_AGENT_DIR`, provider credentials, and proxy settings remain environment variables.

## Session settings commands

Use `/subagent:settings` to list controls and their current values. Separate `/subagent:enable` and `/subagent:disable` commands avoid an ambiguous toggle. Disabling blocks new launches and resumes without stopping running workers. Whenever delegation is enabled, workers receive durable names and `message_subagent` is available. Automatic recovery and its confirmation prompt have separate controls below.

| Command | Setting or behavior |
| --- | --- |
| `/subagent:max-total 80` | Total agent budget, including nested agents |
| `/subagent:max-tasks-per-call 20` | Maximum tasks submitted in one call |
| `/subagent:max-concurency 4` | Root-only session override for the shared cap of 4 live workers across the entire tree; extra launches and saved-worker resumes wait in one cross-process FIFO queue |
| `/subagent:max-depth 2` | Maximum delegation depth |
| `/subagent:prevent-cycles on` | Block delegation cycles |
| `/subagent:auto-resume off` | Stop automatic recovery of unfinished tasks when reopening a chat or navigating history |
| `/subagent:resume-prompt on` | Ask before recovery in the interactive terminal. `off` recovers without asking; it does not disable recovery |
| `/subagent:intelligence on` | Use configured worker model presets, such as junior and senior |
| `/subagent:confirm-project session` | Approval for repository-defined agents. `ask` requests approval, `session` preapproves for the session, `never` skips prompts rather than blocking agents |

Omit a value to inspect it. Boolean commands accept `on` and `off`, also `true` and `false`. Counts require non-negative safe integers; tasks per call and concurrency require at least 1. `/subagent:max-tasks-per-call` limits submissions per call, default 20, using `limits.tasksPerCall` or `PI_SUBAGENT_MAX_TASKS_PER_CALL`. `/subagent:max-concurency` is the exact command spelling. The root initializes the shared tree-global concurrency cap, default 8, from `limits.concurrency` or `PI_SUBAGENT_MAX_CONCURRENCY`. The root command changes that shared cap for this session only; nested workers cannot loosen it.

The root creates one shared cross-process FIFO queue and descendants inherit it. All calls throughout the tree use that queue, including resumes of saved idle workers. Every live worker process counts toward the cap. A waiting parent can save context and exit its process to park, releasing its slot. Launch acknowledgements distinguish `started` from `queued`; they do not wait for completion. Steering a live worker does not take another concurrency slot. `message_subagent` and `stop_subagent` target only the caller's own direct children, checked against both saved owner identity and backend parent token. Grandchildren, siblings, and foreign saved workers are not valid targets. Stopping a direct child still stops its entire subtree, including queued descendants and resumes, without refunding budget reservations.

Waiting parents park instead of rejecting blocked descendants or exceeding the cap. Parking saves context and exits the actual parent process; the root broker owns child process descriptors so children and queued work survive. Parent wakes have lower priority than queued children. Spare capacity can wake a parent before all children finish. Manual messages to parked parents fail, as does a child's `message_lead_agent` while its immediate parent is parked. Wait until the parent resumes.

Preset definitions, the fallback model, extension exclusions, runner executables, retry counts and timeouts remain file settings.

Commands apply to the main session. `/subagent:max-concurency` and `/subagent:max-total` take effect even while the main agent is busy; other settings commands require it to be idle. They override startup environment values and CLI delegation flags for this session, without changing `process.env`. A startup environment disable prevents the entire extension from loading, so commands are unavailable in that case. Child sessions cannot use commands to change inherited grants.

Changes are session-only and clear on session replacement, resume or reload. The concurrency cap is shared across processes, not saved to configuration unless explicitly requested. Lowering the live cap does not stop active workers. Queued work waits until the live-worker count falls below the new cap. Raising the cap admits queued work immediately. Changing the tasks-per-call limit affects new submissions only, not already accepted batches. Budget changes preserve all spent and reserved slots, cannot go below that spending, and cannot enlarge a child's grant. Temporary budget increases disappear when the session ends, but any slots used under them remain spent.

Nothing writes configuration until you run `/subagent:save-settings`. It asks you to choose `project` or `global`; you can also pass the scope directly, such as `/subagent:save-settings project`. Esc cancels. Only settings changed by these commands are saved, preserving unrelated fields. Project saving updates the nearest existing project config, or creates `.pi/pi-subagent.json` in the working directory. Global saving uses Pi's agent config directory. Normal environment and trusted-project precedence applies again in future sessions.

## Tool descriptions

`tool-prompts` in either settings filename replaces a tool's full model-facing description:

```json
{
  "tool-prompts": {
    "subagents": "Your full asynchronous delegation instructions.",
    "message_subagent": "Your full named-worker messaging instructions.",
    "message_lead_agent": "Your full child-to-lead messaging instructions."
  }
}
```

Missing descriptions retain their defaults. Overrides change written guidance, not schemas, budget checks, or runtime limits. Keep instructions to estimate worker counts and avoid unnecessary delegation.

Describe launch results as immediate `started` or `queued` acknowledgements, not final output. Completion arrives as lead steering. `message_subagent` steers running workers or resumes idle ones; the child-only `message_lead_agent` sends nonblocking lead steering. Both completion and child messages wake an idle lead.

## Human messaging and live activity

`/message_subagent` selects live targets before asking for message text. Choose `All (+nested)` for all live workers, `All` for top-level workers, `Youngest` for live workers without running descendants, or `Names (e.g. John, Maria)` for comma-separated names or nested paths. There is no `No` choice; Esc cancels. Automatic broadcast interception of ordinary user input has been removed. This human command is separate from the `message_subagent` model tool, which can also resume a saved worker.

The TUI shows one live line above the editor, such as `Running 2: John 12s · Maria 8s`, with an overflow count and a separate idle count when needed. Timer ticks use live handles and snapshots, not session metadata or disk reads. `/subagent:expand` lists running workers by depth, top levels before nested workers, then live idle parents waiting for children, then completed or stopped history.

## Caller-selected intelligence

Define named model presets in `pi-subagent.json` or `pi-subagents.json`. With two or more enabled presets, the calling model must choose a configured `intelligence` preset for every launch item. With exactly one enabled preset, the launch tool hides the argument and automatically uses that preset. With no presets, the argument is absent and existing model/thinking defaults apply to launches. `message_subagent` never offers or accepts an intelligence choice. No router or separate model-selection request is used.

```json
{
  "subagents-models": [
    {
      "junior": {
        "model": "gpt-4.1-mini",
        "provider": "openai",
        "reasoning-level": "off",
        "description": "Small, well-defined edits and lookups."
      }
    },
    {
      "senior": {
        "model": "gpt-6-astra",
        "provider": "openai-codex",
        "reasoning-level": "high",
        "description": "Difficult architecture and cross-system debugging."
      }
    }
  ]
}
```

Use models available in your Pi installation. Names are arbitrary, unique, non-empty strings without leading or trailing whitespace. Each array entry defines one preset. `model`, `provider`, and `reasoning-level` are required. Accepted reasoning levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; support depends on the selected model and Pi version. `description` is optional. The tool schema shows each name with its description, or just its name when omitted.

```json
{
  "tasks": [
    {
      "agent": "code-writer",
      "task": "Fix the button label.",
      "max_subagents_allowed": 0,
      "intelligence": "junior"
    }
  ]
}
```

A selected or automatic preset overrides the parent model and agent model/thinking settings for a launch. The parent's explicit `--provider` and `--api-key` are not forwarded when a preset is selected. Named resumes use their saved provider and retain a CLI `--api-key` only when that provider matches the parent's explicit `--provider`; otherwise they drop the key. Worker providers use their configured Pi credentials. With multiple presets, omitted or `null` choices reject the entire launch batch before any worker starts or budget changes.

`message_subagent` retains the worker's original effective model, thinking level, and intelligence label, whether it steers a running worker or resumes an idle one. This also applies after restart, preset changes, disabling intelligence, changing the parent model, or editing/deleting the agent definition. A worker launched without a preset remains unlabelled. Pass only `{ name, message }` and an optional `max_subagents_allowed`; any `intelligence` argument, including `null`, is invalid.

Tool result rows show the selected preset, for example `Nicolas (Junior/code-writer)`. Display names capitalize only the first character; configured spelling and argument values otherwise stay unchanged. Runs without a preset show `Nicolas (code-writer)`. Runs without an agent type show `Nicolas (Junior)`, or just `Nicolas` when neither qualifier exists. Agent types come only from user-created definitions. With no available types, the launch schema omits `agent` and uses a default worker without agent-specific instructions. Durable results retain their own preset name, and the name registry retains the initial choice. The `/subagent:expand` picker shows the initial preset beside each agent type and lets you search by preset name. Its transcript view shows each task's or resumed turn's recorded intelligence alongside its actual transcript model and thinking level. Later messages do not relabel earlier work. Missing model or thinking metadata remains `unknown`, even when a preset name is known.

`PI_SUBAGENT_INTELLIGENCE=true` enables presets when they exist, which is the default. Set it to `false` or `0` to treat the configuration as having no presets for new launches: the launch tool hides the argument and no automatic preset applies. Named workers still retain their original settings when messaged or resumed. Unknown choices or attempts to pass a named hidden argument fail before launching workers. When the argument is hidden, omission or `null` still uses the automatic sole preset or existing defaults.

Configuration follows the trust checks and file order above. A later `subagents-models` block replaces the entire earlier block. An empty list disables selection. Invalid blocks warn and disable selection rather than using a partial list. Nested workers load configuration using the same rules. Reload Pi after changing settings.

The old `smart-decision` block is ignored. Remove it and its router credentials when migrating. Configuration files are no longer modified at runtime.

## Limits and discovery

| Setting | Default | Meaning |
| --- | --- | --- |
| `PI_SUBAGENT_MAX_TOTAL_AGENTS` | `50` | New-agent budget for a new main session's entire tree |
| `PI_SUBAGENT_MAX_TASKS_PER_CALL` | `20` | Tasks submitted per call |
| `PI_SUBAGENT_MAX_CONCURRENCY` | `8` | Live worker processes across the entire session tree, including parents still live while waiting; parked parents have exited and do not count. Descendants inherit the root's shared FIFO queue and cap |
| `PI_SUBAGENT_MAX_DEPTH` / `--subagent-max-depth` | `3` | Maximum delegation depth; `0` blocks delegation |
| `PI_SUBAGENT_PREVENT_CYCLES` / `--subagent-prevent-cycles` | `true` | Block agent types already in the delegation stack |
| `PI_SUBAGENT_CONFIRM_PROJECT_AGENTS` | `ask` | `true` / `ask` prompts for approval; `false` / `never` trusts projects; `session` remembers approval |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Agent definitions and configuration directory |

```bash
pi --subagent-max-depth 2
pi --no-subagent-prevent-cycles
```

Cycle-blocked tasks fail individually; legal siblings still run. A nested tool error does not mark a worker as failed if it recovers and completes successfully. Agent limits do not cap spending and are not a security sandbox.

## Process lifecycle

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_SUBAGENT_STARTUP_TIMEOUT` | `120000` | Milliseconds to first model turn; `0` disables |
| `PI_SUBAGENT_STARTUP_RETRIES` | `2` | Fresh retries after startup timeout |
| `PI_SUBAGENT_IDLE_TIMEOUT` | `1200000` | Milliseconds without agent activity; `0` disables |
| `PI_SUBAGENT_PI_COMMAND` | Current runtime | Explicit launch command for embedded hosts |
| `PI_SUBAGENT_PI_ARGS_PREFIX` | Current entrypoint | JSON argument array for the explicit command |

The idle watchdog pauses during tool execution. When the last concurrent tool finishes, a fresh idle window starts. Agent events and changed nested-worker state reset it; unchanged heartbeats do not. Timeout and cancellation terminate the process tree and bound cleanup even if the OS never reports closure.

Worker-turn completion waits for `agent_settled`, not `agent_end`, because Pi may retry, compact, or continue after a low-level run ends. This wait happens in the background, not inside the lead's launch or messaging tool call.

If descendants are still active at `agent_settled`, the runner reports `Idle, waiting for children.` with the worker's own last answer to the lead via steering. A live waiting parent counts toward the cap. Parking saves its context and exits the process, freeing a slot while the root broker preserves child execution. Automatic parent wakes wait behind queued children but may use spare capacity before all children finish. Manual messages and child-to-lead tool calls fail while the parent is parked. Final `Finished` status and completion steering wait until the whole subtree and resulting continuations have settled. Rejected prompts, signal exits, and exit before settlement are failures. A finished durable worker remains available for later resume through `message_subagent`.

Children inherit provider, authentication, proxy, home, temporary-directory, and Pi environment settings. On Windows, the runner normalizes `Path`/`PATH` and adds Node, `PNPM_HOME`, npm's user bin, `%LOCALAPPDATA%\\pnpm`, and `%SystemRoot%\\System32` to executable search paths.

Normally Pi restarts through `process.execPath process.argv[1]`. No package-manager shim or installation layout is assumed.

## Forwarded CLI arguments

Children inherit the parent's CLI settings except arguments managed by the extension. Without an intelligence preset, every new launch explicitly selects the parent's active model, so `/model` changes affect subsequent launches.

Forwarded unchanged:

- `--provider`, `--api-key`, `--system-prompt`, `--session-dir`, `--models`
- `--skill`, `--no-skills` / `-ns`
- `--prompt-template`, `--no-prompt-templates` / `-np`
- `--theme`, `--no-themes`, `--verbose`
- Unknown flags, using heuristic value detection

Fallback values:

- `--model`: replaced by the live parent model; agent frontmatter is a no-context fallback.
- `--thinking`: agent frontmatter wins.
- `--tools` / `--no-tools`: agent frontmatter wins.

Never forwarded:

`--mode`, `-p`, `--print`, `--session`, `--no-session`, `--continue`, `--resume`, `--append-system-prompt`, `--offline`, `--extension`, `-e`, `--no-extensions`, `-ne`, `--subagent-max-depth`, `--subagent-prevent-cycles`, `--export`, `--list-models`, `--help`, `--version`.

Resume settings and internal storage variables are listed in [sessions and budgets](sessions.md).
