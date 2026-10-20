import { budgetPrompt } from "../budget.js";
import { MESSAGE_SUBAGENT_TOOL_NAME, STOP_SUBAGENT_TOOL_NAME, SUBAGENT_TOOL_NAME } from "../types.js";
import { getSubagentsToolDescription } from "./prompts.js";
import { ensureBudget } from "./runtime.js";
import type { ExtensionState } from "./state.js";
import { schedulerFor } from "./scheduler.js";

export function registerPromptHook(state: ExtensionState): void {
  state.pi.on("before_agent_start", async (event) => {
    try {
      if (!state.canDelegate) {
        if (!state.toolsRegistered) return;
        return {
          systemPrompt: `${event.systemPrompt}\n\nDelegation is disabled. Use stop_subagent with one worker name or an array of names to kill each target and its entire descendant subtree, including queued tasks and resumes. Other branches are unaffected; spent and reserved budget is not refunded.`,
        };
      }

      const scheduler = schedulerFor(state);
      const workers = scheduler.treeStore?.snapshot() ?? scheduler.snapshot();
      const queued = workers.filter(({ status }) => status === "queued").length;
      const running = workers.filter(({ status }) =>
        ["running", "started", "parking", "stopping"].includes(status),
      ).length;
      const suspended = workers.filter(({ status }) => ["suspended", "waking"].includes(status)).length;
      const concurrency = scheduler.concurrency;
      const hasAgentTypes = state.discoveredAgents.length > 0;
      const agentList = hasAgentTypes
        ? state.discoveredAgents.map((a) => `- **${a.name}**: ${a.description}`).join("\n")
        : "No agent types are available. Workers receive only the task, with no agent-specific instructions. Omit the agent field.";
      let allowance: string;
      try {
        allowance = budgetPrompt(ensureBudget(state), state.currentDepth === 0 ? "main" : "subagent");
      } catch (error) {
        allowance = `New subagent launches are blocked: ${error instanceof Error ? error.message : error}`;
      }
      const subagentsGuidance =
        state.configuredToolPrompts[SUBAGENT_TOOL_NAME] ??
        `### Subagent use

${getSubagentsToolDescription(hasAgentTypes)}

- Maximum tasks per call: ${state.maxTasksPerCall}. Global live-worker limit across the entire nested tree: ${concurrency}. Live waiting parents also count. Currently ${running} live or stopping, ${queued} tasks queued, ${suspended} parents suspended or waiting to wake. Accepted tasks beyond that limit queue until a slot is free. Queued tasks already reserve their budget. Neither limit increases the task-wide agent budget.`;
      const delegationStackText =
        state.ancestorAgentStack.length > 0 ? state.ancestorAgentStack.join(" -> ") : "(root)";
      const delegationGuardGuidance = `### Delegation guards

- ${allowance}
- Current depth: ${state.currentDepth}; max depth: ${state.maxDepth}
- Cycle prevention: ${state.preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${delegationStackText}
${
  state.preventCycles && hasAgentTypes
    ? "- Agents already in this stack are intentionally omitted from the available list. Do not request omitted agent names."
    : hasAgentTypes
      ? "- Cyclic delegation is allowed by configuration."
      : "- Untyped workers are limited by depth and budget, not agent-type cycles."
}`;
      const resumeGuidance =
        state.configuredToolPrompts[MESSAGE_SUBAGENT_TOOL_NAME] ??
        `### Subagent messages

Launches return immediately with durable worker names and started or queued status. Launches and named resumes at every depth share the same tree-global live-worker limit. Idle parents can be checkpointed and unloaded so children run first, then resume from their saved session when capacity is free. Each worker's completion arrives as a steering message, waking you if idle. Keep working rather than waiting on the launch tool.

Use \`message_subagent\` with { "name": "John", "message": "Now also update the tests." } to steer one of your own direct children or wake it with its saved context and original model settings. Do not address grandchildren, siblings, ancestors or another agent's workers; those requests return errors. A suspended parent cannot receive manual messages until it has resumed. Set "name" to an array, e.g. ["John", "Maria"], to send the same message to several workers concurrently. Each recipient sees only the message, never the recipient list.

Do not run bash sleep or poll for results. Finish your turn and go idle when there is no other work; child completions and messages wake you automatically. Keep the session open.

A message to a queued direct child is retained until it starts; it does not bypass the queue or launch a duplicate worker. An idle worker's resume queues when all slots are occupied.

Optional \`max_subagents_allowed\` changes the lifetime descendant cap without resetting spending. Omit it to keep the current allowance. Increases reserve slots from the original launcher; decreases do not refund slots. Names survive restarts.

Workers can call \`message_lead_agent\` to notify their immediate parent without waiting for a reply. If the parent is suspended this tool returns an error; finish the task instead, and its automatic completion is retained for the parent's next wake. Reply with \`message_subagent\`; the reply wakes an idle worker.`;
      const stopGuidance =
        state.configuredToolPrompts[STOP_SUBAGENT_TOOL_NAME] ??
        `### Stop subagents

Use \`stop_subagent\` with { "name": "John" } or { "name": ["John", "Maria"] } when work is no longer needed. Only your own direct children may be targeted. It kills each targeted child and all descendants, including detached processes and queued tasks or resumes, without stopping other branches. Stops do not refund spent or reserved budget. It reports stopped, canceled, idle, or unknown for each name. Canceled work does not restart automatically. A later explicit message can resume a stopped worker if it has a saved session. This tool remains available after delegation is disabled.`;
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Available Subagents

${hasAgentTypes ? "The following agent types are available via the `subagents` tool:" : "Use the `subagents` tool to launch workers:"}

${agentList}\n\n${subagentsGuidance}\n\n${delegationGuardGuidance}\n\n${resumeGuidance}\n\n${stopGuidance}`,
      };
    } catch (err) {
      console.error("[pi-subagent] Error in before_agent_start:", err);
    }
  });
}
