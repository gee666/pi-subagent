# Pi subagent

Delegate tasks to agents running in separate Pi processes. Each worker has its own context and saved session. The lead receives completion text and usage statistics, not the worker's reasoning or tool transcript.

Launches return immediately. Completion and worker messages arrive as steering that wakes an idle lead.

Requires Pi 1.4.0 or newer, using the `@earendil-works` SDK packages. Only the latest npm Pi release is tested.

Tested against Pi 1.4.0

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

## Configuration

Use either `pi-subagent.json` or `pi-subagents.json`. Both filenames are permanently supported. User-configurable extension options have grouped JSON settings, with precedence **environment > JSON > defaults**.

```json
{
  "limits": { "total": 50, "tasksPerCall": 20, "concurrency": 8 },
  "delegation": { "depth": 3, "preventCycles": true },
  "runner": { "startupTimeoutMs": 120000 }
}
```

See [settings files](docs/configuration.md#settings-files) for locations, all settings, environment mappings, and trust rules.

For session-only changes, use `/subagent:enable`, `/subagent:disable`, `/subagent:max-total 80`, `/subagent:max-tasks-per-call 20`, or `/subagent:max-concurency 4`. `/subagent:settings` lists all [session controls](docs/configuration.md#session-settings-commands). Nothing is saved unless you run `/subagent:save-settings`, which asks whether to save to the project or globally.

## Extension controls

Exclude extensions from child agents without changing which extensions the parent loads:

```bash
PI_SUBAGENT_EXCLUDE_EXTENSIONS="oira666_pi-free-swarm,@scope/other-package,./local-extension.ts" pi
```

The originally requested hyphenated name is also supported. Use `env` because most shells cannot assign hyphenated variable names directly:

```bash
env 'PI-SUBAGENT-EXCLUDE-EXTENSIONS=oira666_pi-free-swarm' pi
```

Both variables accept comma-separated lists; whitespace and empty entries are ignored, and the two lists are combined. Entries match a package source, package name (including `npm:@scope/name@version`, ignoring the version), or an extension file/directory path. Automatic and settings-listed extension paths use the nearest owning `package.json` after resolving symlinks; loose hooks do not inherit the current workspace's or Pi configuration directory's package name. Relative paths resolve from the worker's working directory; `~/` and symlinks are supported. Commas inside paths are not supported in environment lists; use the JSON `extension.exclude` array for those paths. These variables are inherited by nested workers.

When a list is nonempty, the runner discovers enabled extensions without executing them, then launches the child with `--no-extensions` and explicit paths for every remaining extension, including authentication providers. This covers automatic user/project extensions and forwarded `-e` sources. An original `--no-extensions` still suppresses automatic extensions. Project resources are included only when the parent's live context trusts that working directory; unknown trust fails closed. The same trust decision is passed to the child. With no exclusions, launch behavior is unchanged and no extra discovery runs.

Discovery does not install packages or edit settings. Remote explicit `-e` sources must already be installed in Pi's user package location (or its supported legacy global npm location); temporary-only and project-only remote installs must first be installed there or passed as local paths. If Pi leaves a directory unresolved, pass its entry-point file explicitly so file exclusions cannot be bypassed by directory loading. Missing or invalid sources fail the launch rather than falling back to unfiltered loading. Pi's offline mode skips missing automatic packages, as usual. Filtering controls extension entry points, not code imported by an allowed extension, and the allowlist is a launch-time snapshot until the next delegation.

Disable this entire extension, including its tools, commands, flags, providers, and event handlers:

```bash
PI_SUBAGENT_DISABLED=1 pi
```

`true` (case-insensitive) also disables it; `PI-SUBAGENT-DISABLED` is an equivalent alias. Other values leave it enabled. The setting applies to the current process and is inherited by children. It is separate from child-extension exclusions, which do not disable anything in the parent. Restart Pi or reload extensions after changing the process environment.

## Launch and message workers

```json
{
  "tasks": [
    { "task": "Implement the API", "max_subagents_allowed": 0 },
    { "task": "Review the design", "max_subagents_allowed": 0 }
  ]
}
```

Call `subagents` with one or more tasks, up to 20 by default. It returns immediately, reporting workers as `started` or `queued` without waiting for completion. The root session creates one shared cross-process FIFO queue, inherited by descendants, with a default cap of 8 live workers across the entire tree. Live parent workers count until their processes exit. A waiting parent can park by saving its context and exiting to free capacity for children. Nested workers cannot loosen the cap. Queued work starts when a live worker releases capacity. Each completion arrives separately as lead steering, including when the lead is idle. The lead can continue other work after launching workers.

Every task requires task text and a descendant allowance. The `agent` argument exists only when user-created agent definitions are available. The `intelligence` argument exists only when two or more enabled presets are configured. These choices are independent; with neither, task items contain only `task` and `max_subagents_allowed`. Use `0` for a worker that will not delegate, or `1` to let it launch one subagent. The caller reserves one slot for the worker plus its descendant allowance.

Workers with zero descendant allowance receive no delegation tools or added delegation guidance. They still have `message_lead_agent` to contact the lead. Raising `max_subagents_allowed` through `message_subagent` restores delegation tools, subject to the depth limit. Workers that spent a positive allowance keep their tools so they can message existing children.

Workers always receive durable human names when delegation is enabled. `message_subagent` is available whenever delegation is enabled, independently of automatic recovery settings. Call `message_subagent(name, message, max_subagents_allowed?)` to contact one of your own direct children:

```json
{ "name": "John", "message": "Now update the tests." }
```

Send the same message to several workers with an array of names:

```json
{ "name": ["John", "Maria"], "message": "The shared API changed. Use the new signature." }
```

Each recipient receives only the message text, not the recipient list. Duplicate names receive one copy. Running workers receive steering without taking another concurrency slot. Saved idle workers resume through the same tree-global FIFO queue and wait if the cap is full. A parent process still alive while waiting for children already occupies a slot. Delivery failures are reported per recipient without undoing successful deliveries. An optional `max_subagents_allowed` applies separately to each recipient.

A message steers a running worker or resumes an idle worker with its saved context. It does not wait for the worker to finish. `agent` selects a definition at launch; `name` identifies an existing worker. Messaging or resuming a named worker consumes no new budget slot. Resuming an idle worker still needs concurrency capacity. An optional budget increase can reserve additional descendant slots. See [sessions and budgets](docs/sessions.md) for cap overrides, ownership, and crash recovery.

Both `message_subagent` and `stop_subagent` accept only the caller's own direct children. The saved owner identity and backend parent token must match. The root cannot address grandchildren, siblings, or another owner's saved workers. Ask the worker's parent instead. Use `stop_subagent` with a direct child's `name` or array of names to stop each named child's entire subtree, including queued descendants and resumes. Stopping queued work prevents it from starting; stopping live workers releases concurrency capacity. Neither refunds reserved budget.

Waiting parents park instead of deadlocking or exceeding the cap. Their processes exit after saving context; the root broker retains child process descriptors and queued work. Parent wakes have lower priority than queued children, but spare capacity can wake a parent before all its children finish. Manual messages to a parked parent fail, and `message_lead_agent` fails while its immediate parent is parked. Wait for the parent to resume. The root can change the shared cap for this session with `/subagent:max-concurency`.

A child calls `message_lead_agent(message)` to send nonblocking steering to its lead:

```json
{ "message": "The API change needs a migration. Should I include it?" }
```

Subagent notifications use Pi's theme-aware custom-message box, distinct from human user messages. Completion and idle reports use the same message styling.

The child continues without waiting for a reply. The steering wakes an idle lead; the lead can reply with `message_subagent`. Worker completion uses the same lead-steering delivery path, so no polling or blocking wait tool is needed.

Delegate only when parallel work or context isolation saves enough effort to cover worker startup and coordination. Pass existing findings with the task so workers do not repeat your research.

Do not use Bash `sleep` or polling loops to wait for workers. Continue useful work, or end the turn and let completion steering wake the lead. Keep the session open. While the lead is idle and worker work remains, an animated `Waiting for subagents - don't close the session` line appears above the unchanged `Running N` line. Active lead turns keep Pi's normal `Working` indicator.

## Agent definitions

There are no bundled agents. Without user-created definitions, every task uses the same default worker, with no agent-specific system prompt or instructions. It receives the parent's task text unchanged. Pi's normal system prompt and delegation limits still apply.

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

The body is appended to Pi's system prompt. Project definitions override user/environment definitions of the same name.

See [configuration](docs/configuration.md) for frontmatter, layer restrictions, prompt overrides, and environment settings.

## Interactive controls

Collapsed results show each child's name, task, status, and most recent activity anywhere in its subtree. `Ctrl+O` expands the newest call from memory without reading historical transcripts.

A live single line above the editor shows `Running N: Name elapsed · Name elapsed`, with `+N` for names that do not fit and a separate idle count. It uses live handles and snapshots, not session metadata or disk reads on timer ticks.

`/subagent:expand <name>` opens a saved worker transcript. Its top section shows the current descendant-slot budget: allowed, used/reserved, and remaining. Used slots include allowances reserved for children and their descendants, not just currently running processes. Missing legacy budgets show as unknown. With no name, it opens a searchable picker. Running workers come first in depth order, with top-level workers before nested workers. Live idle parents waiting for children come next; completed or stopped history comes last. Name completion is fuzzy. Each task or resumed turn shows its actual provider/model and thinking level from the worker's session, not the parent's settings. Selected presets also appear as an intelligence label, kept separately for each run. Missing historical model/thinking metadata appears as `unknown`.

[Model presets](docs/configuration.md#caller-selected-intelligence) show labels such as `Nicolas (Junior/code-writer)` in regular tool results. One enabled preset applies automatically to new launches without exposing an `intelligence` argument. Two or more require an explicit `intelligence` choice on every launch item. Omitted or `null` choices reject the whole launch batch before any worker starts. Zero or disabled presets keep the existing launch defaults and show no intelligence label. Without an agent type, labels show `Nicolas (Junior)`; without either qualifier, they show just `Nicolas`. `message_subagent` does not accept `intelligence`; workers retain the original effective model, thinking, and label, even after configuration or parent settings change.

| Key | Action |
| --- | --- |
| Left / Right | Previous / next turn |
| T | Current turn's tool list |
| Up / Down, Enter | Select and open a tool or nested child |
| C | Children across all turns |
| Esc | Back one level: tool detail, tools/children, parent subagent, then the searchable list. From the list or a directly named subagent, close. |
| /, n, N | Search, next match, previous match |
| q | Close from any transcript view |

`/message_subagent` is the human command for steering live workers. Choose `All (+nested)` for the whole live tree, `All` for top-level workers, `Youngest` for live workers with no running descendants, or `Names (e.g. John, Maria)` for comma-separated names or paths such as `John > Maria`. Then enter the message. There is no `No` choice; Esc cancels. The command does not resume completed workers. Automatic broadcast interception has been removed, so ordinary user input stays with the lead and never opens a routing prompt.

A worker that has settled its own turn but still has descendants reports `Idle, waiting for children.` to the lead via steering, followed by its own last answer. While live it counts toward the cap. If parked, its process exits and the root broker later resumes its saved context. `Finished` means the whole subtree has settled, not just the worker's own turn.

The single-line dim `WITH SUBS` widget below the editor includes recursive worker usage. It appears only after at least one subagent has been used; no usage summary is added to the status footer. Resuming a named worker adds usage without increasing the unique-worker count. See [usage accounting](docs/usage.md) for programmatic results.

## Development

```bash
npm ci
npm run check
```

`npm test` first installs the four declared Pi SDK packages at `@latest` with `--save-dev --ignore-scripts`, then typechecks before running tests. `npm run check` uses that same path and also checks formatting and file size. Network access is required, and a newer Pi release can update `package.json` and `package-lock.json`. Keep those changes together.

Tests use the real SDK packages installed as development dependencies. SDK/loader integration tests exercise extension loading and argument validation. Terminal rendering tests use test themes, including ANSI styling, width limits and theme invalidation. They do not verify every installed theme or a live interactive terminal. Prompt guidance tests check generated text, not model behavior. No host loader or permissive type shims are needed. Run tests outside a delegated worker environment, or unset inherited `PI_SUBAGENT_*` storage and budget variables first.

Source organization:

| Directory | Responsibility |
| --- | --- |
| `extension/` | Tool registration, session lifecycle, policy, recovery provider, steering |
| `runner/` | Child launch, RPC events, watchdogs, process cleanup |
| `storage/` | Budget ledger, name registry, session files and validation |
| `types/` | Runtime contracts, transcript parsing, outcomes, usage aggregation |
| `ui/` | Transcript views, trees, navigation and overlays |

Root entry points preserve existing imports. The main `index.ts` entry keeps its default extension registration export and the named exports `selectParentModelForSubagent`, `getSubagentsToolDescription`, `collectCombinedUsageStatusLine`, and `collectLiveUsageSummary`. `config.ts` and `agents.ts` discover configuration and definitions. Runtime and test files stay below 350 lines; the name list is static data.

See [async performance and memory](docs/async-performance.md) for cache behavior, test evidence, and remaining limits.

## Attribution and license

Inspired by [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [pi-mono](https://github.com/badlogic/pi-mono). MIT licensed.
