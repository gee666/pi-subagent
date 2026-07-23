import { getAgentDir } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PI_SUBAGENTS_CONFIG_FILE = "pi-subagents.json";

export interface PiSubagentsConfig {
  toolPrompts: Record<string, string>;
}

function readToolPrompts(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`[pi-subagent] Ignoring invalid config "${filePath}". Expected a JSON object.`);
      return {};
    }

    const toolPrompts = (parsed as Record<string, unknown>)["tool-prompts"];
    if (toolPrompts === undefined) return {};
    if (!toolPrompts || typeof toolPrompts !== "object" || Array.isArray(toolPrompts)) {
      console.warn(`[pi-subagent] Ignoring invalid tool-prompts in "${filePath}". Expected an object of tool-name to prompt strings.`);
      return {};
    }

    const result: Record<string, string> = {};
    for (const [toolName, prompt] of Object.entries(toolPrompts)) {
      if (typeof prompt === "string" && prompt.trim().length > 0) {
        result[toolName] = prompt;
      } else {
        console.warn(`[pi-subagent] Ignoring invalid prompt for tool "${toolName}" in "${filePath}". Expected a non-empty string.`);
      }
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagent] Failed to read config "${filePath}": ${message}`);
    return {};
  }
}

/** Find the nearest project-local .pi/pi-subagents.json while walking up from cwd. */
export function findProjectConfig(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, ".pi", PI_SUBAGENTS_CONFIG_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load tool prompt overrides from lowest to highest priority:
 *   ~/.pi/pi-subagents.json
 *   $PI_CODING_AGENT_DIR/pi-subagents.json (normally ~/.pi/agent/pi-subagents.json)
 *   nearest project .pi/pi-subagents.json (trusted projects only)
 */
export function loadPiSubagentsConfig(
  cwd?: string,
  includeProject = false,
): PiSubagentsConfig {
  const paths = [
    path.join(os.homedir(), ".pi", PI_SUBAGENTS_CONFIG_FILE),
    path.join(getAgentDir(), PI_SUBAGENTS_CONFIG_FILE),
  ];
  if (cwd && includeProject) {
    const projectConfig = findProjectConfig(cwd);
    if (projectConfig) paths.push(projectConfig);
  }

  const toolPrompts: Record<string, string> = {};
  for (const filePath of new Set(paths)) {
    Object.assign(toolPrompts, readToolPrompts(filePath));
  }
  return { toolPrompts };
}
