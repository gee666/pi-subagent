export const BASE_SUBAGENTS_TOOL_DESCRIPTION =
  "Run agents in separate processes. Pass { tasks: [{ agent, task, max_subagents_allowed }] }. Calls block until all tasks finish; put parallel tasks in one array.";

export const SUBAGENT_USAGE_GUIDANCE = [
  "When to launch new subagents:",
  "1. Launch new subagents for independent review, when parallel work will save substantial time, or when a large task would crowd out your context and force compaction. Every new agent costs money and must learn its task from scratch. The benefit must cover that setup and the work of combining results. Permission to delegate is not a reason to do it.",
  "2. Before launching, say what each agent will do and why delegation helps. Set max_subagents_allowed on every task: count all descendants, excluding the assigned agent. Use 0 for a direct worker, or 1 for a worker that launches its own reviewer. Each task reserves one slot for the worker plus its descendant cap. Siblings get separate shares; unused shares stay reserved for resumes. Count only workers the planned work needs, not speculative teams. The whole call is rejected if the total exceeds your remaining slots. Respect any tighter user limit.",
  "3. Prefer a few independent workers, not workers each building teams. Another management layer must save enough attention to pay for itself. Passing your whole task unchanged to another agent just adds a relay. Do not launch new agents merely to read a file, run a command, or make a small edit.",
  "4. Delegate before deep research. Agents do not inherit your conversation. If you already gathered findings, share them in the task or a handoff file under the project's tmp/ directory, using its absolute path. Include scope, constraints, relevant files, decisions, completed checks, and expected output. Ask agents to check evidence and fill gaps, not repeat your research.",
].join("\n");

export function getSubagentsToolDescription(): string {
  return `${BASE_SUBAGENTS_TOOL_DESCRIPTION}\n\n${SUBAGENT_USAGE_GUIDANCE}`;
}

export function sameToolPrompts(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}
