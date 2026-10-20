import { readBudget } from "../budget.js";
import type { SessionContext } from "./contracts.js";
import { ensureSubagentToolActive } from "./policy.js";
import { loadPiSubagentsConfig, type PiSubagentsConfig } from "../config.js";
import { discoverAgents } from "../agents.js";
import { filterAgentsForPrompt } from "./policy.js";
import { configuredEnv, SETTING_DEFINITIONS } from "../settings.js";
import { registerSubagentsTool } from "./launch-tool.js";
import { sameToolPrompts } from "./prompts.js";
import { registerMessageSubagentTool } from "./message-tool.js";
import { registerLeadMessageTool } from "./lead-message-tool.js";
import { registerStopSubagentTool } from "./stop-tool.js";
import type { ExtensionState } from "./state.js";

export function registerToolsWithConfig(
  state: ExtensionState,
  cwd?: string,
  includeProject = false,
  force = false,
  config: PiSubagentsConfig = loadPiSubagentsConfig(cwd, includeProject, state.sessionSettings),
): void {
  state.discoveredAgents = filterAgentsForPrompt(
    discoverAgents(cwd ?? process.cwd(), "both", config.settings).agents,
    state.currentDepth,
    state.maxDepth,
    state.ancestorAgentStack,
    state.preventCycles,
  );
  const configKey = JSON.stringify([
    SETTING_DEFINITIONS.map(([, , env]) => configuredEnv(env, config.settings)),
    state.canDelegate,
    state.discoveredAgents,
  ]);
  const settingsChanged = state.registeredConfigKey !== configKey;
  state.registeredConfigKey = configKey;
  const presetsChanged = JSON.stringify(state.intelligencePresets) !== JSON.stringify(config.intelligencePresets);
  state.intelligencePresets = config.intelligencePresets;
  state.settings = config.settings;
  const nextToolPrompts = config.toolPrompts;
  if (!force && !settingsChanged && !presetsChanged && sameToolPrompts(state.configuredToolPrompts, nextToolPrompts))
    return;
  state.configuredToolPrompts = nextToolPrompts;
  if (state.currentDepth > 0 && !state.disabled) registerLeadMessageTool(state.pi);
  if (!state.canDelegate && !state.toolsRegistered) return;
  state.toolsRegistered = true;
  registerSubagentsTool(state);
  registerMessageSubagentTool(state);
  registerStopSubagentTool(state);
}

/** A running leaf can receive a larger allowance without losing its session. */
export function refreshWorkerAllowance(state: ExtensionState, ctx: SessionContext): void {
  if (state.currentDepth === 0 || !state.currentBudget || state.disabled) return;
  let allowed = false;
  try {
    allowed = state.currentDepth < state.maxDepth && readBudget(state.currentBudget).limit > 0;
  } catch {
    // A broken ledger must not grant delegation.
  }
  if (allowed === state.canDelegate) return;
  state.canDelegate = allowed;
  if (allowed) {
    registerToolsWithConfig(state, ctx.cwd, ctx.isProjectTrusted(), true);
    ensureSubagentToolActive(state.pi);
  } else {
    state.pi.setActiveTools(
      state.pi.getActiveTools().filter((name) => name !== "subagents" && name !== "message_subagent"),
    );
  }
}

export function registerTools(state: ExtensionState): void {
  state.refreshRegisteredToolPrompts = (cwd, includeProject, config) => {
    registerToolsWithConfig(state, cwd, includeProject, false, config);
  };

  registerToolsWithConfig(state, undefined, false, true);
}
