import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionEvents } from "./extension/events.js";
import { registerSubagentExpandCommand } from "./extension/expand-command.js";
import { registerPromptHook } from "./extension/prompt-hook.js";
import { registerResumeProvider } from "./extension/provider.js";
import { registerSessionLifecycle } from "./extension/session-start.js";
import { createExtensionState } from "./extension/state.js";
import { registerTools } from "./extension/tool-registration.js";

export { selectParentModelForSubagent } from "./extension/models.js";
export { getSubagentsToolDescription } from "./extension/prompts.js";
export { collectCombinedUsageStatusLine, collectLiveUsageSummary } from "./extension/usage.js";

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 3).",
    type: "string",
  });
  pi.registerFlag("subagent-prevent-cycles", {
    description: "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });
  const state = createExtensionState(pi);
  registerResumeProvider(state);
  registerSessionLifecycle(state);
  registerSessionEvents(state);
  registerPromptHook(state);
  if (state.canDelegate) registerTools(state);
  registerSubagentExpandCommand(state);
}
