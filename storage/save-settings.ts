import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { SETTING_DEFINITIONS, type SubagentSettings } from "../settings.js";
import { findProjectConfig, PI_SUBAGENT_CONFIG_FILE, PI_SUBAGENTS_CONFIG_FILE } from "./config-files.js";
import { isRecord } from "./values.js";

function decode(value: string, type: (typeof SETTING_DEFINITIONS)[number][3]): unknown {
  if (type === "string" && value.trim()) return value;
  if (type === "confirmation" && ["ask", "never", "session"].includes(value)) return value;
  if ((type === "boolean" || type === "confirmation") && ["true", "false"].includes(value)) return value === "true";
  if (type === "integer" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  if (type === "list") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
    } catch {
      // Report only the setting name below, never its contents.
    }
  }
  return undefined;
}

/** Explicitly merge supplied settings into a config file. No defaults or environment values are saved.
 * Global writes use the canonical personal filename, preserving the plural config when singular is absent.
 * Project runner executable overrides are rejected.
 * Invalid input, malformed JSON, and non-object sections being updated throw without writing.
 */
export function saveSubagentSettings(cwd: string, scope: "project" | "global", settings: SubagentSettings): string {
  if (scope !== "project" && scope !== "global") throw new Error("Invalid settings scope.");
  const file =
    scope === "project"
      ? (findProjectConfig(cwd) ?? path.resolve(cwd, ".pi", PI_SUBAGENT_CONFIG_FILE))
      : path.join(getAgentDir(), PI_SUBAGENT_CONFIG_FILE);
  // Match loader collision priority before creating the canonical global file.
  const sourceFile =
    scope === "global" && !fs.existsSync(file) ? path.join(path.dirname(file), PI_SUBAGENTS_CONFIG_FILE) : file;
  let config: Record<string, unknown> = {};
  let source: string | undefined;
  try {
    source = fs.readFileSync(sourceFile, "utf8");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  if (source !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error(`Cannot save settings from "${sourceFile}": invalid JSON.`);
    }
    if (!isRecord(parsed)) throw new Error(`Cannot save settings from "${sourceFile}": expected a JSON object.`);
    config = parsed;
  }
  for (const [group, key, env, type] of SETTING_DEFINITIONS) {
    if (!Object.hasOwn(settings, env)) continue;
    if (scope === "project" && group === "runner" && (key === "command" || key === "argsPrefix"))
      throw new Error(`Cannot save runner.${key} to project settings: personal-only setting.`);
    const encoded = settings[env];
    const value = typeof encoded === "string" ? decode(encoded, type) : undefined;
    if (value === undefined) throw new Error(`Cannot save invalid setting ${env}.`);
    const section = config[group];
    if (section !== undefined && !isRecord(section))
      throw new Error(`Cannot save settings to "${file}": ${group} must be an object.`);
    config[group] = { ...section, [key]: value };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return file;
}
