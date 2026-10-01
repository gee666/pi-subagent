import { intelligenceEnabled, parseIntelligencePresets, type IntelligencePreset } from "./intelligence.js";
import { configPaths, readConfig } from "./storage/config-files.js";
import { readSettings, type SubagentSettings } from "./settings.js";
export { PI_SUBAGENTS_CONFIG_FILE, PI_SUBAGENT_CONFIG_FILE, findProjectConfig } from "./storage/config-files.js";

export interface PiSubagentsConfig {
  toolPrompts: Record<string, string>;
  intelligencePresets: IntelligencePreset[];
  settings: SubagentSettings;
}

function readToolPrompts(config: Record<string, unknown>, filePath: string): Record<string, string> {
  const toolPrompts = config["tool-prompts"];
  if (toolPrompts === undefined) return {};
  if (!toolPrompts || typeof toolPrompts !== "object" || Array.isArray(toolPrompts)) {
    console.warn(
      `[pi-subagent] Ignoring invalid tool-prompts in "${filePath}". Expected an object of tool-name to prompt strings.`,
    );
    return {};
  }

  const result: Record<string, string> = {};
  for (const [toolName, prompt] of Object.entries(toolPrompts)) {
    if (typeof prompt === "string" && prompt.trim().length > 0) {
      result[toolName] = prompt;
    } else {
      console.warn(
        `[pi-subagent] Ignoring invalid prompt for tool "${toolName}" in "${filePath}". Expected a non-empty string.`,
      );
    }
  }
  return result;
}

/** Load personal settings, then the nearest project configuration when trusted. */
export function loadPiSubagentsConfig(cwd?: string, includeProject = false): PiSubagentsConfig {
  const paths = configPaths(cwd, includeProject);
  const personalPaths = new Set(configPaths());
  const settings: SubagentSettings = {};
  const toolPrompts: Record<string, string> = {};
  let intelligencePresets: IntelligencePreset[] = [];
  for (const filePath of new Set(paths)) {
    const config = readConfig(filePath);
    Object.assign(toolPrompts, readToolPrompts(config, filePath));
    Object.assign(settings, readSettings(config, filePath, personalPaths.has(filePath)));
    if (Object.hasOwn(config, "subagents-models")) {
      intelligencePresets = [];
      try {
        intelligencePresets = parseIntelligencePresets(config["subagents-models"]);
      } catch {
        console.warn(`[pi-subagent] Ignoring invalid subagents-models in "${filePath}".`);
      }
    }
  }
  return {
    toolPrompts,
    settings,
    intelligencePresets: intelligenceEnabled(intelligencePresets, settings) ? intelligencePresets : [],
  };
}
