import { loadPiSubagentsConfig } from "../config.js";
import { registerSubagentsTool } from "./launch-tool.js";
import { sameToolPrompts } from "./prompts.js";
import { registerResumeSubagentsTool } from "./resume-tool.js";
import type { ExtensionState } from "./state.js";

export function registerToolsWithConfig(
  state: ExtensionState,
  cwd?: string,
  includeProject = false,
  force = false,
): void {
  const nextToolPrompts = loadPiSubagentsConfig(cwd, includeProject).toolPrompts;
  if (!force && sameToolPrompts(state.configuredToolPrompts, nextToolPrompts)) return;
  state.configuredToolPrompts = nextToolPrompts;
  registerSubagentsTool(state);
  registerResumeSubagentsTool(state);
}

export function registerTools(state: ExtensionState): void {
  state.refreshRegisteredToolPrompts = (cwd, includeProject) => {
    registerToolsWithConfig(state, cwd, includeProject);
  };

  registerToolsWithConfig(state, undefined, false, true);
}
