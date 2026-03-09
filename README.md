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
- **Project agents:** `.pi/agents/*.md` *(may prompt for confirmation — see `PI_SUBAGENT_CONFIRM_PROJECT_AGENTS`)*

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

## create-subagent Skill

If you want the agent to **create new subagent definition files** for itself, install the [`create-subagent` skill](https://github.com/gee666/pi-subagent/tree/main/create-subagent). Once installed, the agent will know how to scaffold new `.md` agent files in the right location with correct frontmatter.

## Attribution

Inspired by [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [mariozechner/pi-mono](https://github.com/badlogic/pi-mono).

## License

MIT
