import { configuredEnv, type SubagentSettings } from "./settings.js";
import { parseBoolean } from "./shared.js";

export const SUBAGENT_INTELLIGENCE_ENV = "PI_SUBAGENT_INTELLIGENCE";
/** Runner-owned metadata, separate from the preset feature toggle. */
export const SUBAGENT_RUN_INTELLIGENCE_ENV = "PI_SUBAGENT_RUN_INTELLIGENCE";
export const SUBAGENT_INTELLIGENCE_CUSTOM_TYPE = "pi-subagent-intelligence";

export function displayIntelligence(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface IntelligencePreset {
  name: string;
  model: string;
  provider: string;
  thinking: string;
  description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A section replaces earlier presets as a whole, including when invalid or empty. */
export function parseIntelligencePresets(raw: unknown): IntelligencePreset[] {
  if (!Array.isArray(raw)) throw new Error("subagents-models must be an array.");
  const presets: IntelligencePreset[] = [];
  const names = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || Object.keys(entry).length !== 1)
      throw new Error("Each subagents-models entry must contain one named preset.");
    const [name, value] = Object.entries(entry)[0];
    if (!name.trim() || name !== name.trim() || names.has(name))
      throw new Error("Intelligence preset names must be non-empty, trimmed, and unique.");
    if (!isRecord(value)) throw new Error("An intelligence preset must be an object.");
    const { model, provider, description } = value;
    const thinking = value["reasoning-level"];
    if (typeof model !== "string" || !model.trim() || typeof provider !== "string" || !provider.trim())
      throw new Error("Intelligence presets require non-empty model and provider strings.");
    if (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking))
      throw new Error("Invalid intelligence preset reasoning-level.");
    if (description !== undefined && (typeof description !== "string" || !description.trim()))
      throw new Error("Intelligence preset description must be a non-empty string when supplied.");
    names.add(name);
    presets.push({
      name,
      model: model.trim(),
      provider: provider.trim(),
      thinking,
      ...(description !== undefined ? { description } : {}),
    });
  }
  return presets;
}

export function intelligenceEnabled(presets: IntelligencePreset[], settings?: SubagentSettings): boolean {
  return presets.length > 0 && parseBoolean(configuredEnv(SUBAGENT_INTELLIGENCE_ENV, settings)) !== false;
}

/** A sole enabled preset is automatic; with multiple presets omission keeps existing defaults. */
export function selectIntelligence(
  presets: IntelligencePreset[] | undefined,
  name: unknown,
  settings?: SubagentSettings,
): IntelligencePreset | undefined {
  if (!presets || !intelligenceEnabled(presets, settings)) {
    if (name === undefined) return undefined;
    throw new Error("Subagent intelligence selection is disabled or no valid presets are configured.");
  }
  if (presets.length === 1) return presets[0];
  if (name === undefined) return undefined;
  const preset = presets.find((item) => item.name === name);
  if (!preset)
    throw new Error(
      `Unknown subagent intelligence. Available presets: ${presets.map((item) => item.name).join(", ")}.`,
    );
  return preset;
}
