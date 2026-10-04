import { loadPiSubagentsConfig, type PiSubagentsConfig } from "../config.js";
import { discoverAgents } from "../agents.js";
import { filterAgentsForPrompt } from "./policy.js";
import { configuredEnv, SETTING_DEFINITIONS } from "../settings.js";
import { registerSubagentsTool } from "./launch-tool.js";
import { sameToolPrompts } from "./prompts.js";
import { registerResumeSubagentsTool } from "./resume-tool.js";
import type { ExtensionState } from "./state.js";

export function registerToolsWithConfig(
  state: ExtensionState,
  cwd?: string,
  includeProject = false,
  force = false,
  config: PiSubagentsConfig = loadPiSubagentsConfig(cwd, includeProject),
): void {
  state.discoveredAgents = filterAgentsForPrompt(
    discoverAgents(cwd ?? process.cwd(), "both").agents,
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
  if (!state.canDelegate && !state.toolsRegistered) return;
  state.toolsRegistered = true;
  registerSubagentsTool(state);
  registerResumeSubagentsTool(state);
}

export function registerTools(state: ExtensionState): void {
  state.refreshRegisteredToolPrompts = (cwd, includeProject, config) => {
    registerToolsWithConfig(state, cwd, includeProject, false, config);
  };

  registerToolsWithConfig(state, undefined, false, true);
}
