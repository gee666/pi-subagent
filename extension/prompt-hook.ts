import { budgetPrompt } from "../budget.js";
import { MESSAGE_SUBAGENT_TOOL_NAME, SUBAGENT_TOOL_NAME } from "../types.js";
import { resumableSubagentsDisabled } from "./policy.js";
import { getSubagentsToolDescription } from "./prompts.js";
import { ensureBudget } from "./runtime.js";
import type { ExtensionState } from "./state.js";

export function registerPromptHook(state: ExtensionState): void {
  state.pi.on("before_agent_start", async (event) => {
    try {
      if (!state.canDelegate) return;

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

- Technical batch capacity: ${state.maxParallelTasks}. This does not increase the task-wide agent budget.`;
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
      const resumeGuidance = resumableSubagentsDisabled(state.settings)
        ? ""
        : (state.configuredToolPrompts[MESSAGE_SUBAGENT_TOOL_NAME] ??
          `### Subagent messages

Launches return immediately with durable worker names. Each worker's completion arrives as a steering message, waking you if idle. Keep working rather than waiting on the launch tool.

Use \`message_subagent\` with { "name": "John", "message": "Now also update the tests." } to steer a running worker or wake an idle worker with its saved context and original model settings. Set "name" to an array, e.g. ["John", "Maria"], to send the same message to several workers concurrently. Each recipient sees only the message, never the recipient list.

Optional \`max_subagents_allowed\` changes the lifetime descendant cap without resetting spending. Omit it to keep the current allowance. Increases reserve slots from the original launcher; decreases do not refund slots. Names survive restarts.

Workers can call \`message_lead_agent\` to send their immediate lead a steering message without waiting for a reply. Reply with \`message_subagent\`; the reply wakes an idle worker.`);
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Available Subagents

${hasAgentTypes ? "The following agent types are available via the `subagents` tool:" : "Use the `subagents` tool to launch workers:"}

${agentList}\n\n${subagentsGuidance}\n\n${delegationGuardGuidance}${resumeGuidance ? `\n\n${resumeGuidance}` : ""}`,
      };
    } catch (err) {
      console.error("[pi-subagent] Error in before_agent_start:", err);
    }
  });
}
