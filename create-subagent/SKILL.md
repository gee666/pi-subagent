---
name: create-subagent
description: >
  Creates new pi subagent definition files (.md with YAML frontmatter) in
  ~/.pi/agent/agents/ (user-global) or .pi/agents/ (project-local).
  Trigger when the user asks to define a new agent, create a specialist, add a
  subagent, write an agent file, or set up a delegated worker for a specific
  task.
---

# Create Subagent

This skill guides you through creating a well-formed pi subagent definition file.
Subagents are Markdown files with YAML frontmatter that pi-subagent discovers at
startup and injects into the main agent's system prompt.

---

## Step 1 — Clarify intent

Before writing anything, gather the following from the user (ask only what isn't
already obvious from context):

1. **What should this agent do?** — its core specialisation.
2. **User-global or project-local?**
   - User-global → `~/.pi/agent/agents/<name>.md` (available in every session)
   - Project-local → `.pi/agents/<name>.md` (scoped to the current repo; requires user confirmation before pi runs it)
3. **Model preference?** — leave blank to use Pi's default; specify when a task
   clearly benefits from a specific model (e.g. a heavy reasoning task → a thinking
   model; a fast lookup task → a smaller/faster model).
4. **Thinking level?** — `off | minimal | low | medium | high | xhigh`. Only set
   this when you know it matters; otherwise omit and let the model default apply.
5. **Tools needed?** — choose the minimal set (see reference below). If unsure,
   leave at defaults (`read, bash, edit, write`).

---

## Step 2 — Choose a name and write the description

**Name rules:**
- Lowercase, hyphen-separated (e.g. `code-reviewer`, `doc-writer`)
- Short and unambiguous — this is the identifier used in tool calls
- Must match exactly when the main agent calls `subagent({ agent: "..." })`

**Description rules:**
- One to two sentences maximum
- Describe *what the agent is good at*, not what it is
- The main agent reads this description to decide which subagent to call — be
  specific and action-oriented (e.g. "Rewrites code for clarity and performance"
  is better than "A code expert")


---

## Step 4 — Write the system prompt (Markdown body)

The Markdown body below the frontmatter becomes the agent's system prompt. It is
*appended* to Pi's default system prompt, not a replacement.

Good system prompts for subagents:
- State the agent's role clearly in the first sentence
- List any hard constraints (e.g. "never modify files outside the `src/` directory")
- Describe the expected output format if it matters (e.g. JSON, diff, prose)
- Keep it concise — the description field already covers "what the agent does";
  the body covers *how* it should behave

---

## Step 5 — Write the file

Use the template below, then save to the appropriate location.

```markdown
---
name: <agent-name>
description: <one or two sentences — what the agent is good at>
model: <provider/model-id>          # omit to use Pi default
thinking: <off|minimal|low|medium|high|xhigh>  # omit to use Pi default
tools: <comma-separated tool list>  # omit for defaults: read,bash,edit,write
---

<System prompt for the agent. Starts here. Be concise.>
```
