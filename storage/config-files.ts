import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PI_SUBAGENTS_CONFIG_FILE = "pi-subagents.json";
export const PI_SUBAGENT_CONFIG_FILE = "pi-subagent.json";

export function readConfig(filePath: string): Record<string, unknown> {
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

/** Both filenames are permanent. Singular wins when both exist at one location. */
export function configPaths(cwd?: string, includeProject = false): string[] {
  const paths = [configAtLocation(path.join(os.homedir(), ".pi")), configAtLocation(getAgentDir())];
  if (cwd && includeProject) {
    const projectConfig = findProjectConfig(cwd);
    if (projectConfig) paths.push(projectConfig);
  }
  return [...new Set(paths)];
}
