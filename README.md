# Pi Subagent

Delegate tasks to specialized subagents.

## Install

```bash
pi install npm:oira666_pi-subagent
```

Or via git:

```bash
pi install git:github.com/gee666/pi-subagent.git
```

## Remove

```bash
pi remove npm:oira666_pi-subagent
```

## How It Works

Each subagent runs as a **separate `pi` process** — fully isolated memory, its own model/tool loop.
Processes are spawned via the operating system and communicate through JSON-line stdout.
Subagent sessions are persisted separately under a `sessions-subagents` directory (a sibling of Pi's normal `sessions` directory), so they can be resumed without mixing into the main session list.

- Full OS-level isolation — a crashed subagent cannot affect the parent
- True parallel execution across all CPU cores
- Each subprocess boots a fresh Node.js runtime
- Uses the same Pi CLI entrypoint as the parent process when available

Each subagent receives only the task string. The main agent in turn receives
only the **final text output** from subagents (no tool calls, no reasoning).

## Tool Call Shape

The delegation tool is called `subagents` (older sessions may contain the
legacy name `subagent`, which is still recognized when reading history):

```json
{ "tasks": [{ "agent": "code-writer", "task": "Implement the API", "max_agents_allowed": 1 }] }
```

Multiple tasks run in parallel:

```json
{
  "tasks": [
    { "agent": "code-writer", "task": "Draft the implementation", "max_agents_allowed": 1 },
    { "agent": "code-reviwer", "task": "Review the plan", "max_agents_allowed": 1 }
  ]
}
```

Each task requires `agent`, `task`, and `max_agents_allowed`. The number includes the assigned agent and every agent below it. Use `1` for a worker that will finish directly.

## Delegation policy

Before launching new agents, the default prompts require a concrete time or context saving that outweighs startup, discovery, and coordination costs.

- Default to direct work rather than launching new agents. Use a small, flat set of specialists for substantial independent slices.
- Choose the fewest agents the task needs. Plan for the whole task, including nested workers and later phases, and respect any limit the user sets.
- Nested workers share the same budget. Each delegated task gets an explicit allowance.
- Another management layer must save enough attention to pay for itself. Prefer direct workers and count all nested agents in the same budget.
- Delegate before deep discovery, or pass existing findings directly or through a handoff file under the project's `tmp/` directory.

The efficiency guidance is a model instruction. Agent budgets and depth restrictions are enforced at runtime, but neither limits dollar spending. Use `pi --subagent-max-depth 1` to block nested delegation.

## Agent budgets

A main session starts with a budget of 50 new agents for its entire delegation tree. Set `PI_SUBAGENT_MAX_TOTAL_AGENTS` before starting a new session to change it. `0` blocks new launches but still permits named resumes. Invalid values block launches rather than silently removing the limit.

The main agent sees its remaining count only when it is below 30. Larger counts stay out of automatic prompts and budget-rejection messages so they do not suggest a target to spend. Enforcement is unchanged. Delegated workers always receive their own remaining allowance.

Each task reserves exactly `max_agents_allowed` slots from its caller. A value of `10` means ten agents total, including the assigned worker. The worker's automatic prompt says it may launch at most nine more subagents, including nested launches. Two tasks with budgets of `4` and `1` reserve five slots in total.

- Choose budgets from the planned work, not the available maximum. Use `1` for a direct worker; `0` is invalid because the assigned worker needs a slot.
- Every nested call must specify allowances too. If a batch would exceed its caller's remaining slots, the extension rejects the whole batch before launching or naming any workers. The error explains the requested and remaining amounts.
- Siblings cannot borrow each other's slots. The extension commits reservations atomically across processes, so concurrent calls cannot spend the same slots.
- Unused allowances stay reserved for later resumes. Finished, failed, or canceled branches do not return slots to their parent. Interrupted calls reuse their original reservations when recovered.
- Named resumes do not consume new slots. The resumed worker, including any private session forks, keeps its current budget unless `max_agents_allowed` overrides it. Past launches and assigned slots still count.
- The extension adds the remaining allowance and explains inclusive branch sizes in the worker's prompt automatically. No hand-written budget instructions are needed.

Budgets survive reloads, restarts, compaction, and session forks. The cap covers the main session's entire tree, not each tool call or user message. Changing the environment does not enlarge an existing tree; start a new main session for a fresh budget. Resuming older workers without recorded budgets gives them no new descendant allowance.

Recorded calls and budgets from the older, exclusive argument remain resumable. The extension converts them without changing their reserved slots or remaining allowance.

Budget state is stored alongside subagent sessions using immutable files and atomic hard links. Missing or corrupt saved state blocks new launches instead of resetting the allowance. The session filesystem must support hard links. This is an agent-count limit, not a spending limit or a security sandbox.

## Tool Prompt Overrides

The complete LLM-facing description of each extension tool can be replaced in
`pi-subagents.json`. Supported locations, from lowest to highest priority:

1. `~/.pi/pi-subagents.json`
2. `$PI_CODING_AGENT_DIR/pi-subagents.json` (normally `~/.pi/agent/pi-subagents.json`)
3. The nearest trusted project `.pi/pi-subagents.json`, walking up from the current directory

Project values override global values per tool. Missing prompts keep their
built-in defaults. Overrides replace the written delegation guidance, not the required budget argument or runtime enforcement. Keep estimation guidance in custom descriptions. Use a JSON object for `tool-prompts`:

```json
{
  "tool-prompts": {
    "subagents": "Your complete replacement prompt for the subagents tool.",
    "resume_subagents": "Your complete replacement prompt for the resume tool."
  }
}
```

## Bundled Agents

Four built-in agents ship with the extension and remain available alongside custom agents by default:

- `code-writer` — implementation and refactoring
- `code-reviwer` — code review and risk finding
- `code-architect` — technical design and approach selection
- `team-lead`: rare coordination of one large subproject. Its bundled `first-layer: only` setting limits launches to the main agent.

## Defining Agents

Create Markdown files with YAML frontmatter:

- **User agents:** `~/.pi/agent/agents/*.md`
- **Env agents:** `$PI_CODING_AGENT_DIR/agents/*.md` *(when `PI_CODING_AGENT_DIR` is set)*
- **Project agents:** `.pi/agents/*.md` *(may prompt for confirmation — see `PI_SUBAGENT_CONFIRM_PROJECT_AGENTS`)*

Agent discovery priority (highest wins on name collision): project > env/user > built-in.
Built-in agents remain available alongside custom agents unless
`PI_SUBAGENT_HIDE_BUILTIN_AGENTS=true`. A custom definition with the same name
as a built-in agent overrides that built-in definition, including its delegation instructions. Update custom copies separately to adopt the bundled policy.

```markdown
---
name: writer
description: Expert technical writer
thinking: low
first-layer: enabled
last-layer: disabled
tools: read,write
---

You are an expert technical writer focused on clarity and conciseness.
```

### Frontmatter Fields

| Field         | Required | Default              | Description                                              |
| ------------- | -------- | -------------------- | -------------------------------------------------------- |
| `name`        | Yes      | —                    | Agent identifier used in tool calls                      |
| `description` | Yes      | —                    | What the agent does (shown to the main agent)            |
| `model`       | No       | Current parent model | Legacy fallback only when live parent model context is unavailable |
| `thinking`    | No       | Pi default           | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`       |
| `tools`       | No       | `read,bash,edit,write` | Comma-separated built-in tools                         |
| `first-layer` | No       | `enabled`            | Rule for depth 1, launched by the main agent |
| `second-layer` | No      | `enabled`            | Rule for depth 2 |
| `last-layer`  | No       | `enabled`            | Rule for the configured maximum depth |
| `nth-layer(1,2,-1)` | No | `enabled`            | Rule for a comma-separated list of layer numbers |

Layer rules accept `enabled`, `disabled`, or `only`:

- `enabled` leaves the selected layers available. It does not restrict other layers or override another rule.
- `disabled` blocks the selected layers.
- `only` restricts the agent to the selected layers. Multiple `only` rules combine their selections. A matching `disabled` rule still wins, regardless of order.

Layer numbers start at 1. Negative numbers count back from the configured maximum depth, so `-1` means last and `-2` means next to last. Repeated numbers are harmless. Numbers outside the configured depth range match nothing. Zero, fractions, malformed selectors, and invalid values produce warnings and are ignored.

```yaml
# Only the main agent can launch this agent.
first-layer: only
```

```yaml
# Allow these layers, then exclude the second layer.
nth-layer(1,2,5,-1,-5): only
second-layer: disabled
```

With maximum depth 8, the second example allows layers 1, 4, 5, and 8. With maximum depth 1, `first-layer: only` still allows layer 1. Adding `last-layer: disabled` would block it.

Available tools: `read`, `bash`, `edit`, `write`.

The Markdown body becomes the agent's system prompt (appended to Pi's default, not replacing it).

## Delegation Guards

Depth and cycle guards restrict nesting but do not cap total launches or spending. Layer availability is evaluated for the child being launched: depth 1 is the first layer, and `PI_SUBAGENT_MAX_DEPTH` is the last layer. The bundled `team-lead` agent sets `first-layer: only`, so only the main agent can launch it. Custom agent definitions can choose other layer rules. When cycle prevention is enabled, agents already in the current delegation stack are omitted from the child model's available-agent list. The runner still checks every task as a safety boundary: in a mixed parallel call, cyclic tasks fail while legal siblings still run.

A nested delegation failure is returned to its calling agent as a recoverable tool error. If that agent subsequently retries, completes the work itself, and produces a successful final answer, the earlier tool error does not incorrectly turn the completed agent—and all of its ancestors—into failures.

| Config                         | Default | Description                                      |
| ------------------------------ | ------- | ------------------------------------------------ |
| `--subagent-max-depth` / `PI_SUBAGENT_MAX_DEPTH` | `3` | Max delegation depth (0 disables delegation) |
| `--subagent-prevent-cycles` / `PI_SUBAGENT_PREVENT_CYCLES` | `true` | Block same agent in delegation chain |

```bash
pi --subagent-max-depth 2         # one nested level
pi --subagent-max-depth 0         # disable delegation entirely
pi --no-subagent-prevent-cycles   # allow cycles (not recommended)
```

## Parallel Limits

| Env Var                          | Default | Description                              |
| -------------------------------- | ------- | ---------------------------------------- |
| `PI_SUBAGENT_MAX_TOTAL_AGENTS` | `50` | Total new-agent budget for a new main session's tree |
| `PI_SUBAGENT_MAX_PARALLEL_TASKS` | `30`    | Max tasks per single call                |
| `PI_SUBAGENT_MAX_CONCURRENCY`    | `8`     | Max subagents running simultaneously     |

## Child Process Environment

Children inherit all provider, authentication, proxy, home, temp, and Pi
environment variables. The runner also repairs the executable search path for
elevated Windows PowerShell and pnpm installations: it normalizes duplicate
`Path`/`PATH` keys and adds the Node directory, `PNPM_HOME`, npm's user bin,
`%LOCALAPPDATA%\\pnpm`, and `%SystemRoot%\\System32`. This also applies to every
nested child, so tools and sub-subagents use the same working environment.

Pi itself is relaunched with the current runtime and entrypoint
(`process.execPath process.argv[1]`). The extension does not inspect npm/pnpm
shims or assume package names, `node_modules` locations, or Pi `dist` layouts.
This also supports Bun and other Node-compatible runtimes with the same process
semantics. Embedded hosts without a script entrypoint can use
`PI_SUBAGENT_PI_COMMAND` and `PI_SUBAGENT_PI_ARGS_PREFIX` explicitly.

## Subagent Liveness Timeouts

A delegated process cannot block its parents forever. The runner applies a
startup timeout before the first model turn and an agent-inactivity timeout
after startup. The inactivity watchdog is paused while any tool call is in
progress, so tool executions can run for unlimited time; a fresh full idle
window starts after the last concurrent tool finishes. Agent/turn events and
changed nested-agent state reset the idle timer; repeated unchanged progress
heartbeats do not. On timeout or cancellation, the runner terminates the child
process tree and bounds cleanup; even if a wedged OS process never reports
`close`, the tool returns an error result so every waiting parent can settle.

RPC completion is based on Pi's `agent_settled` event—not `agent_end`.
`agent_end` is only a low-level run boundary and may be followed by Pi's normal
provider retry, overflow compaction, or queued continuation. Rejected prompt
commands, signal exits, and processes that exit before `agent_settled` are
reported immediately as failures.

| Env Var | Default | Description |
| --- | --- | --- |
| `PI_SUBAGENT_STARTUP_TIMEOUT` | `120000` | Milliseconds allowed to reach the first model turn; `0` disables |
| `PI_SUBAGENT_STARTUP_RETRIES` | `2` | Fresh retries after a startup timeout |
| `PI_SUBAGENT_IDLE_TIMEOUT` | `1200000` | Milliseconds without agent activity after startup, excluding time spent in ongoing tool calls; `0` disables |

## Timestamps & Status Footer

Subagent tool calls and live activity lines render a dim `hh:mm:ss` timestamp.
The collapsed view shows every direct child as `Name (agent-type)`, two prompt
lines, its current status, and `last action`. That timestamp is the newest
activity anywhere in the child's recursive subtree, so active grandchildren
keep their ancestor visibly alive. Press `Ctrl+O` for an instant in-memory
view: the newest subagent tool call is shown verbosely, while older calls stay
as lightweight trees. Ctrl+O never reads historical child session transcripts.

Use `/subagent-expand <name>` (for example `/subagent-expand Olga`) to open a
centered, turn-oriented popup. It starts on the latest turn and shows only that
turn's task/resume prompt, final response, compact tool summary, and collapsed
named children. Use Left/Right to change turns and `T` to open that turn's tool
list; delegation tool rows include a minimal tree of their named children.
Select a tool with Up/Down and press Enter to inspect its full arguments and
result. Every overview also shows its distinct direct children across all turns;
press `C`, select a child, and press Enter to open that child's same expanded
view. `Esc` returns to the parent. `/` opens visible search, `n`/`N` moves
through matches, and `q` closes from anywhere. The command offers fuzzy name
completion, and running `/subagent-expand` with no argument opens a searchable
picker (type to filter hundreds of names by name, agent type, or task). It is
available only in the interactive TUI.

In the tool list, delegation rows expand into their named children, and those
child rows are selectable: press Enter on one to open that subagent's own view.

The count in `WITH SUBS: (N)` is the number of unique subagents, including nested workers. Resuming a subagent or continuing its private session fork does not increase this count. Resume costs and tokens still contribute to the usage totals. Older compact history uses the name registry to recover identities that are no longer stored in the chat.

The `WITH SUBS` status line aggregates `ctx.sessionManager.getEntries()`, which
is the approach Pi documents for extension-side token stats. It applies Pi's own
rules (`AgentSession.getSessionStats`): every billed entry counts, including
off-branch retries, history compacted away, branch summaries, and tool-reported
usage. Delegated cost is added once, from the durable subagent usage summary, so
the combined line can never be lower than Pi's parent-only cost.

In the interactive TUI the extension publishes the combined `total` usage line
(parent + all subagents, recursively) via Pi's normal `ctx.ui.setStatus()`
status line. Pi renders all extension statuses on the same footer status line.

## Steering Running Subagents

While a `subagents` tool call is running, mid-stream steering input can be broadcast to one or more child agents. Targets are selected by human name; nested targets use paths such as `John > Maria > Elena`. The extension uses Pi's `InputEvent.streamingBehavior` metadata when available, so idle prompts and queued follow-ups continue to the parent normally; only true `steer` inputs open the broadcast routing prompt.

## Subagent Session Resume

> Requires Pi **0.81.0 or newer**. Crash recovery uses Pi's public full Provider SDK and session-replacement lifecycle.

Subagent subprocesses save sessions in `sessions-subagents`. When a main Pi session is resumed and its latest branch contains an unfinished `subagents` tool call (aborted, errored, or closed by Pi's synthetic unfinished-tool error), the extension can resume that delegation from the saved subagent sessions.

The same detection also runs after navigating the session tree in the TUI (Esc navigation): if you jump back to a point whose branch ends in an unfinished `subagents` call, the extension offers to resume those subagents from their saved sessions.

- TUI mode asks: **Resume subagents?**
- Non-UI modes (`pi -p`, JSON/RPC) resume automatically.
- Already-finished subagents are reused as completed; unfinished ones continue from their own saved sessions.
- Durable child refs retain final output, own usage, model, and tool counts, so completed siblings survive a JSON/session restart without becoming `(no output)` or losing accounting.
- Nested subagents use the same mechanism recursively.
- Provider fallback goes through the selected model's effective Pi provider, so custom providers, custom APIs, auth-derived endpoints, headers, and provider-scoped environment are preserved.
- Pending resume state and delayed callbacks are discarded on `/resume`, `/new`, `/fork`, and `/reload`, preventing stale work from an old runtime from leaking into the replacement session.

| Env Var | Default | Description |
| --- | --- | --- |
| `PI_SUBAGENT_RESUME_PROMPT` | `true` | Set to `false` to suppress the TUI yes/no prompt and auto-resume. |
| `PI_SUBAGENT_DISABLE_RESUME` | `false` | Set to `true` to disable automatic subagent resume detection entirely. |

Note: crash-resume covers `subagents` calls only. An interrupted `resume_subagents` call is not replayed automatically — the model can simply issue it again, since names stay valid (see below).

## Resumable Subagents by Name (`resume_subagents`)

Every subagent run is assigned a random, durable human first name from a bundled
list of 1000 culturally diverse names — for example `John`, `Octavian`, or `Vishnu`.
Names are never reused anywhere in the same delegation tree. The name is
returned together with the agent type and shown in every TUI view.

The `resume_subagents` tool continues named subagents with a new task while
preserving their full previous context:

```json
{ "resumes": [{ "subagent": "John", "task": "Now also update the tests." }] }
```

Each resume entry may optionally set `max_agents_allowed`:

```json
{ "resumes": [{ "subagent": "John", "task": "Continue the implementation", "max_agents_allowed": 10 }] }
```

This replaces the worker's lifetime cap, including the worker itself. It does not grant ten fresh launches. Omit the field to keep the current cap.

- Increases reserve only the extra capacity from the original launcher's remaining budget. The full-tree cap still applies.
- A decrease cannot remove slots already spent or assigned to nested workers. It also does not return reserved capacity to the parent. Raising the cap back to a previously funded value needs no extra slots.
- A caller can override workers in its own delegation tree. For nested workers, increases use their immediate launcher's allowance. Increase that launcher's cap first if necessary.
- Overrides in one call must share an original launcher. Split overrides for different launchers into separate calls.
- Recorded reservations are required for overrides. Older workers without them can still resume without the optional field.
- Budget changes persist across resumes and forks. If interrupted after funding an increase, the extra capacity stays reserved and a retry does not charge it again.

Naming is deliberately unambiguous: `agent` (in `subagents`) selects an agent
*type* to spawn; `subagent` (in `resume_subagents`) addresses an already-run
subagent *instance* by its unique name.

- All resumes in one call run **in parallel**.
- The preferred shape is `{"resumes":[...]}`. For compatibility, the common single-item shorthand `{"subagent":"name","task":"..."}` is normalized automatically before validation.
- Names are unique within one delegation tree (everything spawned from one
  top-level session) and are persisted in a registry file under the subagent
  session root, so they survive restarts: you can resume a subagent in a later
  session of the same conversation.
- The registry location and the session's ownership identity are stored in the
  session itself (a custom metadata entry). Pi assigns resumed/branched
  sessions a new internal session id, but the persisted identity (plus a
  `parentSession` ancestor-walk fallback for sessions created before it
  existed) keeps the whole tree's names alive across process restarts — for
  the top-level session and every nested subagent alike.
- **Ownership & forks**: the agent that spawned a subagent (its *owner*)
  resumes the original session. A parent may pass names to its own subagents
  (in their task text); when a child resumes a name created by an ancestor, it
  transparently gets a **private fork** of that subagent (a copy of its
  session), so the owner's copy is never polluted by the child's continuation.
  Each child gets exactly **one fork per name** and keeps reusing it on
  subsequent resumes. Fork session locations are persisted too.
- Concurrent resumes of the same target are rejected (in-process and
  cross-process via crash-tolerant registry markers), because two processes
  continuing the same session file would corrupt it.
- If the original agent definition file has been removed, the resume still
  works: the registry remembers the agent's model/tool restrictions and the
  session itself carries the context.

| Env Var | Default | Description |
| --- | --- | --- |
| `DISABLE_RESUMABLE_SUBAGENTS` | `false` | Set to `true`/`on`/`1` to disable resumable subagents entirely: no names are allocated, the `resume_subagents` tool is not registered, and the system prompt omits the feature. |
| `PI_SUBAGENT_NAMES_FILE` | (internal) | Path of the shared name registry, propagated to child processes so the whole delegation tree allocates unique names. |
| `PI_SUBAGENT_BUDGET_DIR` | internal | Child's reserved branch ledger. Passed through the process environment and persisted in session metadata. |

## Agent Discovery

| Env Var                 | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `PI_CODING_AGENT_DIR`   | Override Pi's agent config directory. Agents are read from `$PI_CODING_AGENT_DIR/agents/*.md`, and tool prompts from `$PI_CODING_AGENT_DIR/pi-subagents.json`. |
| `PI_SUBAGENT_HIDE_BUILTIN_AGENTS` | Set to `true`/`on`/`yes`/`1` to hide all bundled agents. By default they are available alongside custom agents. |

## CLI Argument Proxying

Flags passed to the parent `pi` process are forwarded to subagent child
processes, so they inherit the same provider, API key, and other runtime settings. At every new launch, the extension explicitly passes the parent's currently active model; changing `/model` mid-conversation therefore affects all subsequently started subagents. Flags the extension manages itself are blocked from being forwarded.

**Always forwarded verbatim:**

| Flag(s) | Purpose |
| --- | --- |
| `--provider` | AI provider |
| `--api-key` | API key |
| `--system-prompt` | Base system prompt override |
| `--session-dir` | Session storage directory |
| `--models` | Model cycling list |
| `--skill`, `--no-skills`/`-ns` | Skill loading |
| `--prompt-template`, `--no-prompt-templates`/`-np` | Prompt templates |
| `--theme`, `--no-themes` | Themes |
| `--verbose` | Verbose startup output |
| Unknown/custom flags | Forwarded with heuristic value detection |

**Forwarded as fallback** (agent frontmatter overrides if set):

| Flag | Overridden by |
| --- | --- |
| `--model` | Replaced at launch by the parent's currently active model (`model:` is only a no-context compatibility fallback) |
| `--thinking` | `thinking:` in agent frontmatter |
| `--tools` / `--no-tools` | `tools:` in agent frontmatter |

**Never forwarded** (managed by the extension itself):
`--mode`, `-p`/`--print`, `--session`/`--no-session`, `--continue`, `--resume`,
`--append-system-prompt`, `--offline`, `--extension`/`-e`, `--no-extensions`/`-ne`,
`--subagent-max-depth`, `--subagent-prevent-cycles`, `--export`, `--list-models`,
`--help`, `--version`.

---

## Programmatic Usage (JSON RPC)

When running `pi` programmatically with `--mode rpc` (or `--mode json`), the stream contains
`tool_result_end` events whenever the agent completes a `subagents` tool call. The `details` field
of these events carries the full stats for that delegation — including recursive usage and tool
call counts from all subagents in the tree.

### Stream event shape

```
tool_result_end
└── message
    ├── role:        "toolResult"
    ├── toolName:    "subagents"
    ├── toolCallId:  string
    ├── isError:     boolean
    ├── content:     [{ type: "text", text: "<final output>" }]
    └── details:     SubagentDetails
```

### `SubagentDetails` object

```ts
interface SubagentDetails {
  // Execution metadata
  mode: "single" | "parallel";          // one task vs multiple parallel tasks
  delegationMode: "spawn";              // always "spawn" (kept for backward-compatible serialization)
  projectAgentsDir: string | null;      // path to .pi/agents/ dir if used

  // Individual agent results (one per task)
  results: SingleResult[];

  // ── Stats summary (own + all descendants, recursively) ──────────────────
  aggregatedUsage: UsageStats;          // token counts and cost, full tree
  aggregatedToolCalls: ToolCallCounts;  // { toolName: callCount }, full tree

  // ── Per-agent breakdown ──────────────────────────────────────────────────
  usageTree: UsageTreeNode[];           // one root node per result
}

interface SingleResult {
  agent: string;                        // agent name
  agentSource: "user" | "project" | "builtin" | "unknown";
  task: string;                         // task string passed to this agent
  exitCode: number;                     // 0 = process success, >0 = error, -1 = still running
  messages: Message[];                  // full conversation history of the subagent
  stderr: string;
  usage: UsageStats;                    // this agent's OWN token usage only
  toolCalls: ToolCallCounts;            // this agent's OWN tool calls only
  model?: string;
  stopReason?: string;                  // "end_turn" | "error" | "aborted" | ...
  errorMessage?: string;
}

interface UsageStats {
  input: number;                        // input tokens
  output: number;                       // output tokens
  cacheRead: number;                    // cache read tokens
  cacheWrite: number;                   // cache write tokens
  cost: number;                         // total cost in USD
  contextTokens: number;                // snapshot: last context window size (not summed in aggregates)
  turns: number;                        // number of assistant turns
}

// toolName → call count, e.g. { "bash": 5, "read": 3, "subagents": 1 }
type ToolCallCounts = Record<string, number>;

interface UsageTreeNode {
  agent: string;
  task: string;
  ownUsage: UsageStats;                 // only this agent's turns
  ownToolCalls: ToolCallCounts;         // only this agent's tool calls
  aggregatedUsage: UsageStats;          // ownUsage + all children recursively
  aggregatedToolCalls: ToolCallCounts;  // ownToolCalls + all children recursively
  children: UsageTreeNode[];            // one node per nested subagent invocation
}
```

### Important notes on stats

- **`SingleResult.usage`** and **`SingleResult.toolCalls`** cover **only that one agent's own work** —
  not its children. Children run in separate processes; their tokens never appear in the parent's usage.
- **`aggregatedUsage`** / **`aggregatedToolCalls`** on `SubagentDetails` (and on each `UsageTreeNode`)
  are the correct totals to use when you want the cost or tool call count for an entire delegation
  subtree.
- **`contextTokens`** is a point-in-time snapshot of the context window size at the last turn of that
  agent. It is **not** summed in aggregated stats (it would be meaningless as a cross-process sum).
- **`toolCalls`** includes **all** tool calls an agent made, including the `"subagents"` call itself.
  You can use the `"subagents"` count to see how many nested delegations an agent spawned.

### Annotated example JSON

The scenario below: main agent delegates to `code-writer`, which does some file work and then
delegates to `code-reviwer` before finishing.

```json
{
  "type": "tool_result_end",
  "message": {
    "role": "toolResult",
    "toolName": "subagents",
    "toolCallId": "toolu_01XYZ",
    "isError": false,
    "content": [
      {
        "type": "text",
        "text": "Feature implemented and reviewed. Added validation logic in auth.ts and updated the test suite."
      }
    ],
    "details": {
      "mode": "single",
      "delegationMode": "spawn",
      "projectAgentsDir": null,

      "aggregatedUsage": {
        "input": 2180,
        "output": 615,
        "cacheRead": 940,
        "cacheWrite": 120,
        "cost": 0.0079,
        "contextTokens": 0,
        "turns": 3
      },
      "aggregatedToolCalls": {
        "read":     3,
        "bash":     2,
        "edit":     1,
        "subagents": 1
      },

      "usageTree": [
        {
          "agent": "code-writer",
          "task": "Implement the auth feature and have it reviewed",
          "ownUsage": {
            "input": 1380,
            "output": 365,
            "cacheRead": 540,
            "cacheWrite": 120,
            "cost": 0.0058,
            "contextTokens": 2840,
            "turns": 2
          },
          "ownToolCalls": {
            "read":     1,
            "bash":     1,
            "edit":     1,
            "subagents": 1
          },
          "aggregatedUsage": {
            "input": 2180,
            "output": 615,
            "cacheRead": 940,
            "cacheWrite": 120,
            "cost": 0.0079,
            "contextTokens": 0,
            "turns": 3
          },
          "aggregatedToolCalls": {
            "read":     3,
            "bash":     2,
            "edit":     1,
            "subagents": 1
          },
          "children": [
            {
              "agent": "code-reviwer",
              "task": "Review the auth implementation in auth.ts",
              "ownUsage": {
                "input": 800,
                "output": 250,
                "cacheRead": 400,
                "cacheWrite": 0,
                "cost": 0.0021,
                "contextTokens": 1450,
                "turns": 1
              },
              "ownToolCalls": {
                "read": 2,
                "bash": 1
              },
              "aggregatedUsage": {
                "input": 800,
                "output": 250,
                "cacheRead": 400,
                "cacheWrite": 0,
                "cost": 0.0021,
                "contextTokens": 0,
                "turns": 1
              },
              "aggregatedToolCalls": {
                "read": 2,
                "bash": 1
              },
              "children": []
            }
          ]
        }
      ],

      "results": [
        {
          "agent": "code-writer",
          "agentSource": "builtin",
          "task": "Implement the auth feature and have it reviewed",
          "exitCode": 0,
          "stopReason": "end_turn",
          "model": "claude-opus-4-5",
          "stderr": "",
          "usage": {
            "input": 1380,
            "output": 365,
            "cacheRead": 540,
            "cacheWrite": 120,
            "cost": 0.0058,
            "contextTokens": 2840,
            "turns": 2
          },
          "toolCalls": {
            "read":     1,
            "bash":     1,
            "edit":     1,
            "subagents": 1
          },
          "messages": [
            "... full conversation history of code-writer (includes the nested subagent tool_result) ..."
          ]
        }
      ]
    }
  }
}
```

### Collecting stats across an entire session

If you are consuming the JSON stream programmatically and want to track the total cost and tool
usage across all subagent work in a session, listen for every `tool_result_end` event where
`message.toolName === "subagents"` (or the legacy `"subagent"` in old sessions) and sum `message.details.aggregatedUsage` across them.

```js
let totalCost = 0;
const totalToolCalls = {};

for await (const line of jsonLines) {
  const event = JSON.parse(line);
  if (
    event.type === "tool_result_end" &&
    ["subagents", "subagent", "resume_subagents"].includes(event.message?.toolName) &&
    event.message?.details
  ) {
    const { aggregatedUsage, aggregatedToolCalls } = event.message.details;
    totalCost += aggregatedUsage.cost;
    for (const [tool, count] of Object.entries(aggregatedToolCalls)) {
      totalToolCalls[tool] = (totalToolCalls[tool] ?? 0) + count;
    }
  }
}
```

Note: if you also track the main agent's own usage from `message_end` events, make sure **not** to
double-count the subagent costs there — the main agent's own token usage (from its own `message_end`
events) does not include subagent work.

---

## create-subagent Skill

If you want the agent to **create new subagent definition files** for itself, install the [`create-subagent` skill](https://github.com/gee666/pi-subagent/tree/main/create-subagent). Once installed, the agent will know how to scaffold new `.md` agent files in the right location with correct frontmatter.

## Attribution

Inspired by [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [mariozechner/pi-mono](https://github.com/badlogic/pi-mono).

## License

MIT
