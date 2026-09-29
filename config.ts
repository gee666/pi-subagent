import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { intelligenceEnabled, parseIntelligencePresets, type IntelligencePreset } from "./intelligence.js";

export const PI_SUBAGENTS_CONFIG_FILE = "pi-subagents.json";
export const PI_SUBAGENT_CONFIG_FILE = "pi-subagent.json";

export interface PiSubagentsConfig {
  toolPrompts: Record<string, string>;
  intelligencePresets: IntelligencePreset[];
}

function readConfig(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[pi-subagent] Ignoring invalid config "${filePath}". Expected a JSON object.`);
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    // Do not expose configuration contents in parser errors.
    console.warn(`[pi-subagent] Failed to read config "${filePath}".`);
    return {};
  }
}

function configAtLocation(dir: string): string {
  const singular = path.join(dir, PI_SUBAGENT_CONFIG_FILE);
  return fs.existsSync(singular) ? singular : path.join(dir, PI_SUBAGENTS_CONFIG_FILE);
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

/** Find the nearest project-local config while walking up from cwd. */
export function findProjectConfig(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = configAtLocation(path.join(dir, ".pi"));
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load configuration from lowest to highest priority:
 *   ~/.pi/pi-subagents.json
 *   $PI_CODING_AGENT_DIR/pi-subagents.json (normally ~/.pi/agent/pi-subagents.json)
 *   nearest project .pi/pi-subagents.json (trusted projects only)
 * pi-subagent.json replaces pi-subagents.json at each location when present.
 */
export function loadPiSubagentsConfig(cwd?: string, includeProject = false): PiSubagentsConfig {
  const paths = [configAtLocation(path.join(os.homedir(), ".pi")), configAtLocation(getAgentDir())];
  if (cwd && includeProject) {
    const projectConfig = findProjectConfig(cwd);
    if (projectConfig) paths.push(projectConfig);
  }

  const toolPrompts: Record<string, string> = {};
  let intelligencePresets: IntelligencePreset[] = [];
  for (const filePath of new Set(paths)) {
    const config = readConfig(filePath);
    Object.assign(toolPrompts, readToolPrompts(config, filePath));
    if (Object.hasOwn(config, "subagents-models")) {
      intelligencePresets = [];
      try {
        intelligencePresets = parseIntelligencePresets(config["subagents-models"]);
      } catch {
        console.warn(`[pi-subagent] Ignoring invalid subagents-models in "${filePath}".`);
      }
    }
  }
  return { toolPrompts, intelligencePresets: intelligenceEnabled(intelligencePresets) ? intelligencePresets : [] };
}
