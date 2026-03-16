# Pi Subagent

Delegate tasks to specialized subagents with configurable context modes (`spawn` / `fork`).

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

Each subagent runs as a **separate `pi` process** — isolated memory, its own model/tool loop.

**`spawn` (default)** — Child receives only the task string. Best for isolated work, lower cost.
**`fork`** — Child receives a snapshot of the current session context + task. Best for follow-up work.

The main agent receives only the **final text output** from subagents (no tool calls, no reasoning).

## Tool Call Shape

```json
{ "tasks": [{ "agent": "code-writer", "task": "Implement the API" }], "mode": "spawn" }
```

Multiple tasks run in parallel:

```json
{
  "tasks": [
    { "agent": "code-writer", "task": "Draft the implementation" },
    { "agent": "code-reviwer", "task": "Review the plan" }
  ],
  "mode": "fork"
}
```

Each task supports `agent`, `task`, and optional `cwd`.

## Bundled Agents

Three fallback agents ship with the extension (used when no user/project agents are configured):

- `code-writer` — implementation and refactoring
- `code-reviwer` — code review and risk finding
- `code-architect` — technical design and approach selection

## Defining Agents

Create Markdown files with YAML frontmatter:

- **User agents:** `~/.pi/agent/agents/*.md`
- **Env agents:** `$PI_CODING_AGENT_DIR/agents/*.md` *(when `PI_CODING_AGENT_DIR` is set)*
- **Project agents:** `.pi/agents/*.md` *(may prompt for confirmation — see `PI_SUBAGENT_CONFIRM_PROJECT_AGENTS`)*

Agent discovery priority (highest wins on name collision): project > env > user.
Built-in agents are only used as a fallback when **all three** locations are empty.

```markdown
---
name: writer
description: Expert technical writer
model: anthropic/claude-3-5-sonnet
thinking: low
tools: read,write
---

You are an expert technical writer focused on clarity and conciseness.
```

### Frontmatter Fields

| Field         | Required | Default              | Description                                              |
| ------------- | -------- | -------------------- | -------------------------------------------------------- |
| `name`        | Yes      | —                    | Agent identifier used in tool calls                      |
| `description` | Yes      | —                    | What the agent does (shown to the main agent)            |
| `model`       | No       | Pi default           | Override model, e.g. `anthropic/claude-3-5-sonnet`       |
| `thinking`    | No       | Pi default           | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`       |
| `tools`       | No       | `read,bash,edit,write` | Comma-separated built-in tools                         |

Available tools: `read`, `bash`, `edit`, `write`.

The Markdown body becomes the agent's system prompt (appended to Pi's default, not replacing it).

## Delegation Guards

Depth and cycle guards prevent runaway recursive delegation.

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
| `PI_SUBAGENT_MAX_PARALLEL_TASKS` | `16`    | Max tasks per single call                |
| `PI_SUBAGENT_MAX_CONCURRENCY`    | `8`     | Max subagents running simultaneously     |

## Agent Discovery

| Env Var                 | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `PI_CODING_AGENT_DIR`   | Base path for an additional agents directory (`$PI_CODING_AGENT_DIR/agents/*.md`). Agents here override user agents but are overridden by project agents. Built-in agents are only used when user, env, and project locations all yield zero agents. |

## CLI Argument Proxying

All flags passed to the parent `pi` process are forwarded to subagent child processes, so they
inherit the same provider, API key, model, and other runtime settings. Flags the extension manages
itself are blocked from being forwarded.

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
| `--model` | `model:` in agent frontmatter |
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
`tool_result_end` events whenever the agent completes a `subagent` tool call. The `details` field
of these events carries the full stats for that delegation — including recursive usage and tool
call counts from all subagents in the tree.

### Stream event shape

```
tool_result_end
└── message
    ├── role:        "toolResult"
    ├── toolName:    "subagent"
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
  delegationMode: "spawn" | "fork";     // context mode used
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
  exitCode: number;                     // 0 = success, >0 = error, -1 = still running
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

// toolName → call count, e.g. { "bash": 5, "read": 3, "subagent": 1 }
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
- **`toolCalls`** includes **all** tool calls an agent made, including the `"subagent"` call itself.
  You can use the `"subagent"` count to see how many nested delegations an agent spawned.

### Annotated example JSON

The scenario below: main agent delegates to `code-writer`, which does some file work and then
delegates to `code-reviwer` before finishing.

```json
{
  "type": "tool_result_end",
  "message": {
    "role": "toolResult",
    "toolName": "subagent",
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
        "subagent": 1
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
            "subagent": 1
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
            "subagent": 1
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
            "subagent": 1
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
`message.toolName === "subagent"` and sum `message.details.aggregatedUsage` across them.

```js
let totalCost = 0;
const totalToolCalls = {};

for await (const line of jsonLines) {
  const event = JSON.parse(line);
  if (
    event.type === "tool_result_end" &&
    event.message?.toolName === "subagent" &&
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
events) does not include subagent work; they are always separate processes.

---

## create-subagent Skill

If you want the agent to **create new subagent definition files** for itself, install the [`create-subagent` skill](https://github.com/gee666/pi-subagent/tree/main/create-subagent). Once installed, the agent will know how to scaffold new `.md` agent files in the right location with correct frontmatter.

## Attribution

Inspired by [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [mariozechner/pi-mono](https://github.com/badlogic/pi-mono).

## License

MIT
