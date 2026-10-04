import { configPaths, readConfig } from "./storage/config-files.js";

type SettingType = "boolean" | "integer" | "string" | "list" | "confirmation";

/** JSON paths and environment counterparts. Runtime metadata is deliberately absent. */
export const SETTING_DEFINITIONS = [
  ["extension", "disabled", "PI_SUBAGENT_DISABLED", "boolean"],
  ["extension", "exclude", "PI_SUBAGENT_EXCLUDE_EXTENSIONS", "list"],
  ["agents", "confirmProject", "PI_SUBAGENT_CONFIRM_PROJECT_AGENTS", "confirmation"],
  ["limits", "total", "PI_SUBAGENT_MAX_TOTAL_AGENTS", "integer"],
  ["limits", "parallel", "PI_SUBAGENT_MAX_PARALLEL_TASKS", "integer"],
  ["limits", "concurrency", "PI_SUBAGENT_MAX_CONCURRENCY", "integer"],
  ["delegation", "depth", "PI_SUBAGENT_MAX_DEPTH", "integer"],
  ["delegation", "preventCycles", "PI_SUBAGENT_PREVENT_CYCLES", "boolean"],
  ["resume", "disabled", "DISABLE_RESUMABLE_SUBAGENTS", "boolean"],
  ["resume", "disableAuto", "PI_SUBAGENT_DISABLE_RESUME", "boolean"],
  ["resume", "prompt", "PI_SUBAGENT_RESUME_PROMPT", "boolean"],
  ["models", "intelligence", "PI_SUBAGENT_INTELLIGENCE", "boolean"],
  ["models", "fallback", "PI_SUBAGENT_FALLBACK_MODEL", "string"],
  ["runner", "startupTimeoutMs", "PI_SUBAGENT_STARTUP_TIMEOUT", "integer"],
  ["runner", "idleTimeoutMs", "PI_SUBAGENT_IDLE_TIMEOUT", "integer"],
  ["runner", "startupRetries", "PI_SUBAGENT_STARTUP_RETRIES", "integer"],
  ["runner", "command", "PI_SUBAGENT_PI_COMMAND", "string"],
  ["runner", "argsPrefix", "PI_SUBAGENT_PI_ARGS_PREFIX", "list"],
] as const satisfies ReadonlyArray<readonly [string, string, string, SettingType]>;

export type SettingEnv = (typeof SETTING_DEFINITIONS)[number][2];
/** Validated JSON settings encoded for the existing environment parsers. Never written to process.env. */
export type SubagentSettings = Partial<Record<SettingEnv, string>>;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function encode(value: unknown, type: SettingType): string | undefined {
  if (type === "boolean" && typeof value === "boolean") return String(value);
  if (type === "integer" && typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (type === "string" && typeof value === "string" && value.trim()) return value;
  if (type === "confirmation") {
    if (typeof value === "boolean") return String(value);
    if (typeof value === "string" && ["ask", "never", "session"].includes(value)) return value;
  }
  if (type === "list" && Array.isArray(value) && value.every((item) => typeof item === "string"))
    return JSON.stringify(value);
  return undefined;
}

/** Executable runner overrides are personal-only, even when the SDK reports project trust. */
export function readSettings(config: Record<string, unknown>, file: string, personal = true): SubagentSettings {
  const settings: SubagentSettings = {};
  for (const group of new Set(SETTING_DEFINITIONS.map(([group]) => group))) {
    if (config[group] !== undefined && !record(config[group]))
      console.warn(`[pi-subagent] Ignoring invalid ${group} in "${file}". Expected an object.`);
  }
  for (const [group, key, env, type] of SETTING_DEFINITIONS) {
    const section = config[group];
    if (!record(section) || !Object.hasOwn(section, key)) continue;
    if (!personal && group === "runner" && (key === "command" || key === "argsPrefix")) {
      console.warn(`[pi-subagent] Ignoring project runner.${key} in "${file}". This setting is personal-only.`);
      continue;
    }
    const value = encode(section[key], type);
    if (value === undefined) {
      console.warn(`[pi-subagent] Invalid ${group}.${key} in "${file}". Expected ${type}.`);
      // A malformed budget must block launches rather than silently grant the default allowance.
      if (env === "PI_SUBAGENT_MAX_TOTAL_AGENTS") settings[env] = "invalid setting";
    } else settings[env] = value;
  }
  return settings;
}

/** Personal settings only by default. Project settings require an explicit trusted cwd. */
export function loadSubagentSettings(cwd?: string, includeProject = false): SubagentSettings {
  const personalPaths = new Set(configPaths());
  return Object.assign(
    {},
    ...configPaths(cwd, includeProject).map((file) => readSettings(readConfig(file), file, personalPaths.has(file))),
  );
}

/** An explicitly set environment value wins even if empty or invalid, preserving existing parsers. */
export function configuredEnv(
  name: string,
  settings: SubagentSettings = loadSubagentSettings(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[name] ?? settings[name as SettingEnv];
}
