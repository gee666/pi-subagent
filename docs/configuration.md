# Configuration

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

## Tool descriptions

Use `pi-subagent.json` to configure model presets or replace either tool's full model-facing description. Files load in this order, with later values overriding earlier values per tool:

1. `~/.pi/pi-subagent.json`
2. `$PI_CODING_AGENT_DIR/pi-subagent.json`, normally `~/.pi/agent/pi-subagent.json`
3. The nearest trusted `.pi/pi-subagent.json`, walking upward from the working directory

The legacy filename `pi-subagents.json` is also supported. At each location, the singular filename takes precedence over the plural filename.

```json
{
  "tool-prompts": {
    "subagents": "Your full delegation instructions.",
    "resume_subagents": "Your full resume instructions."
  }
}
```

Missing descriptions retain their defaults. Overrides change written guidance, not schemas, budget checks, or runtime limits. Keep instructions to estimate worker counts and avoid unnecessary delegation.

## Caller-selected intelligence

Define named model presets in `pi-subagent.json`. With two or more enabled presets, the calling model chooses through each task's optional `intelligence` argument. With exactly one enabled preset, both tools hide the argument and automatically use that preset for every launch and resume. With no presets, the argument is absent and existing model/thinking defaults apply. No router or separate model-selection request is used.

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

With multiple presets, `resume_subagents` also accepts `intelligence` on each resume item. A selected or automatic preset overrides the parent model and agent model/thinking settings for that run. The parent's explicit `--provider` and `--api-key` are not forwarded when a preset is selected. Worker providers use their configured Pi credentials. With multiple presets, omitting `intelligence` preserves existing defaults; it does not remember a previous preset choice.

Tool result rows show the selected preset, for example `Nicolas (Junior/code-writer)`. Display names capitalize only the first character; configured spelling and argument values otherwise stay unchanged. Runs without a preset show `Nicolas (code-writer)`. Durable results retain their own preset name, and the name registry retains the initial choice. `/subagent-expand` shows each task's or resume's recorded intelligence alongside its actual transcript model and thinking level. Later resumes do not relabel earlier work. Missing model or thinking metadata remains `unknown`, even when a preset name is known.

`PI_SUBAGENT_INTELLIGENCE=true` enables presets when they exist, which is the default. Set it to `false` or `0` to treat the configuration as having no presets: both tools hide the argument and no automatic preset applies. Unknown choices or attempts to pass a hidden argument fail before launching workers.

Configuration follows the trust checks and file order above. A later `subagents-models` block replaces the entire earlier block. An empty list disables selection. Invalid blocks warn and disable selection rather than using a partial list. Nested workers load configuration using the same rules. Reload Pi after changing settings.

The old `smart-decision` block is ignored. Remove it and its router credentials when migrating. Configuration files are no longer modified at runtime.

## Limits and discovery

| Setting | Default | Meaning |
| --- | --- | --- |
| `PI_SUBAGENT_MAX_TOTAL_AGENTS` | `50` | New-agent budget for a new main session's entire tree |
| `PI_SUBAGENT_MAX_PARALLEL_TASKS` | `30` | Tasks per call |
| `PI_SUBAGENT_MAX_CONCURRENCY` | `8` | Simultaneously running workers per call |
| `PI_SUBAGENT_MAX_DEPTH` / `--subagent-max-depth` | `3` | Maximum delegation depth; `0` blocks delegation |
| `PI_SUBAGENT_PREVENT_CYCLES` / `--subagent-prevent-cycles` | `true` | Block agent types already in the delegation stack |
| `PI_SUBAGENT_HIDE_BUILTIN_AGENTS` | `false` | Hide bundled definitions when set to `true`, `on`, `yes`, or `1` |
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

RPC completion waits for `agent_settled`, not `agent_end`, because Pi may retry, compact, or continue after a low-level run ends. Rejected prompts, signal exits, and exit before settlement are failures.

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
