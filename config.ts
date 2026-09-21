import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseSmartDecisionConfig, type SmartDecisionConfig } from "./runner/smart-decision.js";

export const PI_SUBAGENTS_CONFIG_FILE = "pi-subagents.json";

export interface PiSubagentsConfig {
  toolPrompts: Record<string, string>;
  smartDecision?: SmartDecisionConfig;
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
    // JSON parser errors can contain source text, including the API key.
    console.warn(`[pi-subagent] Failed to read config "${filePath}".`);
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let tempFileCounter = 0;

/** Add the explicit default without allowing a failed write to change runtime behavior. */
function persistSmartDecisionFallback(config: Record<string, unknown>, filePath: string): void {
  const smartDecision = config["smart-decision"];
  if (!isRecord(smartDecision) || Object.hasOwn(smartDecision, "fallback")) return;

  smartDecision.fallback = true;
  let tempPath: string | undefined;
  let ownsTemp = false;
  try {
    // Replace the target rather than a symlink that points to it.
    const targetPath = fs.realpathSync(filePath);
    // Re-read immediately before writing so unrelated edits made since the initial load survive.
    // Retrying also makes concurrent nested-worker migrations converge without clobbering one another.
    for (let attempt = 0; attempt < 3; attempt++) {
      const source = fs.readFileSync(targetPath, "utf8");
      const latest = JSON.parse(source) as unknown;
      if (!isRecord(latest)) return;
      const latestSmartDecision = latest["smart-decision"];
      if (!isRecord(latestSmartDecision)) return;
      if (Object.hasOwn(latestSmartDecision, "fallback")) {
        smartDecision.fallback = latestSmartDecision.fallback;
        return;
      }

      latestSmartDecision.fallback = true;
      const mode = fs.statSync(targetPath).mode & 0o7777;
      const candidatePath = path.join(
        path.dirname(targetPath),
        `.${path.basename(targetPath)}.${process.pid}.${tempFileCounter++}.tmp`,
      );
      const fd = fs.openSync(candidatePath, "wx", mode);
      tempPath = candidatePath;
      ownsTemp = true;
      try {
        fs.writeFileSync(fd, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
        fs.fchmodSync(fd, mode);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      if (fs.readFileSync(targetPath, "utf8") !== source) {
        fs.unlinkSync(tempPath);
        tempPath = undefined;
        ownsTemp = false;
        continue;
      }
      fs.renameSync(tempPath, targetPath);
      tempPath = undefined;
      ownsTemp = false;
      return;
    }
    throw new Error("config changed during fallback migration");
  } catch {
    if (ownsTemp && tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup. Do not expose filesystem errors or configuration contents.
      }
    }
    console.warn("[pi-subagent] Failed to save the default smart-decision fallback.");
  }
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
 * Load configuration from lowest to highest priority:
 *   ~/.pi/pi-subagents.json
 *   $PI_CODING_AGENT_DIR/pi-subagents.json (normally ~/.pi/agent/pi-subagents.json)
 *   nearest project .pi/pi-subagents.json (trusted projects only)
 */
export function loadPiSubagentsConfig(cwd?: string, includeProject = false): PiSubagentsConfig {
  const paths = [
    path.join(os.homedir(), ".pi", PI_SUBAGENTS_CONFIG_FILE),
    path.join(getAgentDir(), PI_SUBAGENTS_CONFIG_FILE),
  ];
  if (cwd && includeProject) {
    const projectConfig = findProjectConfig(cwd);
    if (projectConfig) paths.push(projectConfig);
  }

  const toolPrompts: Record<string, string> = {};
  let smartDecision: SmartDecisionConfig | undefined;
  for (const filePath of new Set(paths)) {
    const config = readConfig(filePath);
    persistSmartDecisionFallback(config, filePath);
    Object.assign(toolPrompts, readToolPrompts(config, filePath));
    if (Object.hasOwn(config, "smart-decision")) {
      smartDecision = parseSmartDecisionConfig(config["smart-decision"]);
    }
  }
  return { toolPrompts, ...(smartDecision ? { smartDecision } : {}) };
}
