import { budgetPrompt } from "../budget.js";
import { RESUME_SUBAGENTS_TOOL_NAME, SUBAGENT_TOOL_NAME } from "../types.js";
import { resumableSubagentsDisabled } from "./policy.js";
import { getSubagentsToolDescription } from "./prompts.js";
import { ensureBudget } from "./runtime.js";
import type { ExtensionState } from "./state.js";

export function registerPromptHook(state: ExtensionState): void {
  state.pi.on("before_agent_start", async (event) => {
    try {
      if (!state.canDelegate) return;

      const agentList =
        state.discoveredAgents.length > 0
          ? state.discoveredAgents.map((a) => `- **${a.name}**: ${a.description}`).join("\n")
          : "_No agents are available for the next delegation layer. Do not call the subagents tool._";
      let allowance: string;
      try {
        allowance = budgetPrompt(ensureBudget(state), state.currentDepth === 0 ? "main" : "subagent");
      } catch (error) {
        allowance = `New subagent launches are blocked: ${error instanceof Error ? error.message : error}`;
      }
      const subagentsGuidance =
        state.configuredToolPrompts[SUBAGENT_TOOL_NAME] ??
        `### Subagent use

${getSubagentsToolDescription()}

- Technical batch capacity: ${state.maxParallelTasks}. This does not increase the task-wide agent budget.`;
      const delegationStackText =
        state.ancestorAgentStack.length > 0 ? state.ancestorAgentStack.join(" -> ") : "(root)";
      const delegationGuardGuidance = `### Delegation guards

- ${allowance}
- Current depth: ${state.currentDepth}; max depth: ${state.maxDepth}
- Cycle prevention: ${state.preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${delegationStackText}
${
  state.preventCycles
    ? "- Agents already in this stack are intentionally omitted from the available list. Do not request omitted agent names."
    : "- Cyclic delegation is allowed by configuration."
}`;
      const resumeGuidance = resumableSubagentsDisabled()
        ? ""
        : (state.configuredToolPrompts[RESUME_SUBAGENTS_TOOL_NAME] ??
          `### Resumable subagents

Every subagent run is assigned a unique, durable human name (e.g. \`John\`,
\`Maria\`) which is returned together with its results. Use the
\`resume_subagents\` tool to continue named subagents with a new task while
keeping their full previous context:

\`\`\`json
{ "resumes": [{ "subagent": "John", "task": "Now also update the tests." }] }
\`\`\`

- \`agent\` (in \`subagents\`) is an agent TYPE; \`subagent\` (in \`resume_subagents\`)
  is the unique name of an already-run subagent instance.
- All resumes in one call run in parallel.
- Optional \`max_subagents_allowed\` changes a worker's lifetime descendant cap, excluding itself. Omit it to keep the current allowance. Past launches and assigned slots still count; increases reserve extra slots from its original launcher.
- Names survive restarts; you can resume them in a later session of this conversation.`);
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Available Subagents

The following subagents are available via the \`subagents\` tool:

${agentList}\n\n${subagentsGuidance}\n\n${delegationGuardGuidance}${resumeGuidance ? `\n\n${resumeGuidance}` : ""}`,
      };
    } catch (err) {
      console.error("[pi-subagent] Error in before_agent_start:", err);
    }
  });
}
