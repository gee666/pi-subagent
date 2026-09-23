# Pi subagent

Delegate tasks to agents running in separate Pi processes. Each worker has its own context and saved session. The parent receives its final text and usage statistics, not its reasoning or tool transcript.

Requires Pi 0.87.1 or newer, using the `@earendil-works` SDK packages.

## Install

```bash
pi install npm:oira666_pi-subagent
# Or install from Git:
pi install git:github.com/gee666/pi-subagent.git
```

To remove it:

```bash
pi remove npm:oira666_pi-subagent
```

## Extension controls

Exclude extensions from child agents without changing which extensions the parent loads:

```bash
PI_SUBAGENT_EXCLUDE_EXTENSIONS="oira666_pi-free-swarm,@scope/other-package,./local-extension.ts" pi
```

The originally requested hyphenated name is also supported. Use `env` because most shells cannot assign hyphenated variable names directly:

```bash
env 'PI-SUBAGENT-EXCLUDE-EXTENSIONS=oira666_pi-free-swarm' pi
```

Both variables accept comma-separated lists; whitespace and empty entries are ignored, and the two lists are combined. Entries match a package source, package name (including `npm:@scope/name@version`, ignoring the version), or an extension file/directory path. Automatic and settings-listed extension paths use the nearest owning `package.json` after resolving symlinks; loose hooks do not inherit the current workspace's or Pi configuration directory's package name. Relative paths resolve from the worker's working directory; `~/` and symlinks are supported. Commas inside paths are not supported. These variables are inherited by nested workers.

When a list is nonempty, the runner discovers enabled extensions without executing them, then launches the child with `--no-extensions` and explicit paths for every remaining extension, including authentication providers. This covers automatic user/project extensions and forwarded `-e` sources. An original `--no-extensions` still suppresses automatic extensions. Project resources are included only when the parent's live context trusts that working directory; unknown trust fails closed. The same trust decision is passed to the child. With no exclusions, launch behavior is unchanged and no extra discovery runs.

Discovery does not install packages or edit settings. Remote explicit `-e` sources must already be installed in Pi's user package location (or its supported legacy global npm location); temporary-only and project-only remote installs must first be installed there or passed as local paths. If Pi leaves a directory unresolved, pass its entry-point file explicitly so file exclusions cannot be bypassed by directory loading. Missing or invalid sources fail the launch rather than falling back to unfiltered loading. Pi's offline mode skips missing automatic packages, as usual. Filtering controls extension entry points, not code imported by an allowed extension, and the allowlist is a launch-time snapshot until the next delegation.

Disable this entire extension, including its tools, commands, flags, providers, and event handlers:

```bash
PI_SUBAGENT_DISABLED=1 pi
```

`true` (case-insensitive) also disables it; `PI-SUBAGENT-DISABLED` is an equivalent alias. Other values leave it enabled. The setting applies to the current process and is inherited by children. It is separate from child-extension exclusions, which do not disable anything in the parent. Restart Pi or reload extensions after changing the process environment.

## Launch and resume

```json
{
  "tasks": [
    { "agent": "code-writer", "task": "Implement the API", "max_subagents_allowed": 0 },
    { "agent": "code-reviwer", "task": "Review the design", "max_subagents_allowed": 0 }
  ]
}
```

Call `subagents` with one or more tasks. Tasks run in parallel, subject to the concurrency limit. Every task requires an agent type, task text, and a descendant allowance. Use `0` for a worker that will not delegate, or `1` to let it launch one subagent. The caller reserves one slot for the worker plus its descendant allowance.

Workers with zero descendant allowance receive neither active delegation tools nor added delegation guidance. Raising `max_subagents_allowed` on resume restores the tools, subject to the depth limit. This uses Pi's documented `getActiveTools()` and `setActiveTools()` APIs during `session_start`. Workers that spent a positive allowance keep their tools so they can resume existing children.

Workers receive durable human names. Call `resume_subagents` to continue one with its previous context:

```json
{ "resumes": [{ "subagent": "John", "task": "Now update the tests." }] }
```

`agent` selects a definition; `subagent` identifies an existing worker. Resumes do not consume new slots. See [sessions and budgets](docs/sessions.md) for budget overrides, forks, and crash recovery.

Delegate only when parallel work or context isolation saves enough effort to cover worker startup and coordination. Pass existing findings with the task so workers do not repeat your research.

## Agent definitions

Bundled agents:

- `code-writer`: implementation and refactoring.
- `code-reviwer`: code review. The spelling is retained for compatibility.
- `code-architect`: technical design.
- `team-lead`: coordination of a large subproject, launchable only by the main agent.

Create Markdown files in `~/.pi/agent/agents/`, `$PI_CODING_AGENT_DIR/agents/`, or the project's `.pi/agents/` directory:

```markdown
---
name: writer
description: Writes technical documentation
thinking: low
first-layer: enabled
last-layer: disabled
tools: read,write
---

Write clear, concise technical documentation.
```

The body is appended to Pi's system prompt. Project definitions override user/environment definitions, which override bundled definitions of the same name. Custom definitions replace the bundled instructions too.

See [configuration](docs/configuration.md) for frontmatter, layer restrictions, prompt overrides, and environment settings.

## Interactive controls

Collapsed results show each child's name, task, status, and most recent activity anywhere in its subtree. `Ctrl+O` expands the newest call from memory without reading historical transcripts.

`/subagent-expand <name>` opens a saved worker transcript. With no name, it opens a searchable picker. Name completion is fuzzy. Each task or resume shows its actual provider/model and thinking level from the worker's session, not the parent's settings. Missing historical metadata appears as `unknown`.

| Key | Action |
| --- | --- |
| Left / Right | Previous / next turn |
| T | Current turn's tool list |
| Up / Down, Enter | Select and open a tool or nested child |
| C | Children across all turns |
| Esc | Return to the parent view |
| /, n, N | Search, next match, previous match |
| q | Close |

While workers run, steering input can be broadcast to selected names, including nested paths such as `John > Maria`. Only inputs marked as streaming `steer` open the routing prompt. Idle prompts and queued follow-ups remain with the parent.

The `WITH SUBS` footer includes recursive worker usage. Resuming or privately forking a named worker adds usage without increasing the unique-worker count. See [usage accounting](docs/usage.md) for programmatic results.

## Development

```bash
npm ci
npm run check
```

Tests use the real SDK packages installed as development dependencies. No host loader or permissive type shims are needed. Run tests outside a delegated worker environment, or unset inherited `PI_SUBAGENT_*` storage and budget variables first.

Source organization:

| Directory | Responsibility |
| --- | --- |
| `extension/` | Tool registration, session lifecycle, policy, recovery provider, steering |
| `runner/` | Child launch, RPC events, watchdogs, process cleanup |
| `storage/` | Budget ledger, name registry, session files and validation |
| `types/` | Runtime contracts, transcript parsing, outcomes, usage aggregation |
| `ui/` | Transcript views, trees, navigation and overlays |

Root entry points preserve existing imports. `config.ts` and `agents.ts` discover configuration and definitions. Runtime and test files stay below 350 lines; the name list is static data.

## Attribution and license

Inspired by [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [pi-mono](https://github.com/badlogic/pi-mono). MIT licensed.
