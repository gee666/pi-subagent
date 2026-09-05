/**
 * Agent discovery and configuration.
 *
 * Agents are Markdown files with YAML frontmatter that define name, description,
 * optional model/tools, and a system prompt body.
 *
 * Lookup locations:
 *   - User agents:    ~/.pi/agent/agents/*.md  (or $PI_CODING_AGENT_DIR/agents/ when env var is set)
 *   - Project agents: .pi/agents/*.md  (walks up from cwd)
 *   - Bundled agents: ./agents/*.md    (included unless PI_SUBAGENT_HIDE_BUILTIN_AGENTS is true)
 */

import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBoolean } from "./shared.js";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project" | "builtin";
export type LayerSetting = boolean | "only";
export interface LayerRule {
  layers: number[];
  setting: LayerSetting;
}

export const SUBAGENT_HIDE_BUILTIN_AGENTS_ENV = "PI_SUBAGENT_HIDE_BUILTIN_AGENTS";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  firstLayer?: LayerSetting;
  secondLayer?: LayerSetting;
  lastLayer?: LayerSetting;
  /** Signed layer selectors from nth-layer(...). Negative numbers count from max depth. */
  layerRules?: LayerRule[];
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

const BUNDLED_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Walk up from `cwd` looking for a `.pi/agents` directory. */
function findNearestProjectAgentsDir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseLayerSetting(value: unknown, field: string, filePath: string): LayerSetting {
  if (value === undefined) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "enabled") return true;
    if (normalized === "disabled") return false;
    if (normalized === "only") return "only";
  }
  console.warn(`[pi-subagent] Ignoring invalid ${field} field in "${filePath}". Expected enabled, disabled, or only.`);
  return true;
}

function parseNumberedLayers(frontmatter: Record<string, unknown>, filePath: string): LayerRule[] {
  const rules: LayerRule[] = [];
  for (const [field, value] of Object.entries(frontmatter)) {
    if (!field.startsWith("nth-layer")) continue;
    const match = /^nth-layer\(([^)]+)\)$/.exec(field);
    const parts = match?.[1].split(",").map((part) => part.trim());
    if (
      !parts ||
      !parts.every((part) => /^-?\d+$/.test(part) && Number.isSafeInteger(Number(part)) && Number(part) !== 0)
    ) {
      console.warn(
        `[pi-subagent] Ignoring invalid layer selector "${field}" in "${filePath}". Use nonzero integers, for example nth-layer(1,2,-1).`,
      );
      continue;
    }
    rules.push({ layers: [...new Set(parts.map(Number))], setting: parseLayerSetting(value, field, filePath) });
  }
  return rules;
}

/** Parse a single agent markdown file into an AgentConfig. Returns null on skip. */
export function parseAgentFile(filePath: string, source: AgentSource): AgentConfig | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[pi-subagent] Skipping invalid agent file "${filePath}": ${message}`);
    return null;
  }

  const frontmatter = parsed.frontmatter ?? {};
  const body = parsed.body ?? "";

  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!name || !description) return null;

  let tools: string[] | undefined;
  const rawTools = typeof frontmatter.tools === "string" ? frontmatter.tools.split(",") : frontmatter.tools;
  if (Array.isArray(rawTools)) {
    const parsedTools = rawTools
      .filter((tool): tool is string => typeof tool === "string")
      .map((tool) => tool.trim())
      .filter(Boolean);
    if (parsedTools.length > 0) tools = parsedTools;
  } else if (frontmatter.tools !== undefined) {
    console.warn(
      `[pi-subagent] Ignoring invalid tools field in "${filePath}". Expected a comma-separated string or string array.`,
    );
  }

  return {
    name,
    description,
    tools,
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
    firstLayer: parseLayerSetting(frontmatter["first-layer"], "first-layer", filePath),
    secondLayer: parseLayerSetting(frontmatter["second-layer"], "second-layer", filePath),
    lastLayer: parseLayerSetting(frontmatter["last-layer"], "last-layer", filePath),
    layerRules: parseNumberedLayers(frontmatter, filePath),
    systemPrompt: body,
    source,
    filePath,
  };
}

/** Load all agent definitions from a directory. */
function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const agent = parseAgentFile(path.join(dir, entry.name), source);
    if (agent) agents.push(agent);
  }
  return agents;
}

/**
 * Merge agent layers with last-write-wins deduplication by name.
 * Layers must be passed from lowest to highest priority.
 */
function dedupeAgents(...layers: AgentConfig[][]): AgentConfig[] {
  const agentMap = new Map<string, AgentConfig>();
  for (const agents of layers) {
    for (const agent of agents) agentMap.set(agent.name, agent);
  }
  return Array.from(agentMap.values());
}

function hideBuiltinAgents(): boolean {
  return parseBoolean(process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV]) === true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Whether an agent is available to be launched at the requested child depth. */
export function isAgentEnabledAtLayer(agent: AgentConfig, targetDepth: number, maxDepth: number): boolean {
  if (!Number.isInteger(targetDepth) || !Number.isInteger(maxDepth) || targetDepth < 1 || targetDepth > maxDepth)
    return false;
  const rules: LayerRule[] = [
    { layers: [1], setting: agent.firstLayer ?? true },
    { layers: [2], setting: agent.secondLayer ?? true },
    { layers: [-1], setting: agent.lastLayer ?? true },
    ...(agent.layerRules ?? []),
  ];
  let hasOnly = false;
  let matchesOnly = false;
  for (const { layers, setting } of rules) {
    const matches = layers.some((layer) => (layer < 0 ? maxDepth + layer + 1 : layer) === targetDepth);
    if (setting === false && matches) return false;
    if (setting === "only") {
      hasOnly = true;
      if (matches) matchesOnly = true;
    }
  }
  return !hasOnly || matchesOnly;
}

/**
 * Return only agents that may be advertised for the next delegation.
 *
 * The runner still enforces cycle prevention as a final safety boundary, but
 * forbidden agents must not be presented to the model as available choices.
 */
export function filterAdvertisedAgents(
  agents: AgentConfig[],
  targetDepth: number,
  maxDepth: number,
  delegationStack: string[],
  preventCycles: boolean,
): AgentConfig[] {
  const blocked = preventCycles ? new Set(delegationStack) : null;
  return agents.filter((agent) => isAgentEnabledAtLayer(agent, targetDepth, maxDepth) && !blocked?.has(agent.name));
}

/**
 * Discover all available agents according to the requested scope.
 *
 * Built-in agents are included at the lowest priority unless
 * PI_SUBAGENT_HIDE_BUILTIN_AGENTS is true. Custom agents with the same name
 * override their built-in counterpart.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const builtinAgents = hideBuiltinAgents() ? [] : loadAgentsFromDir(BUNDLED_AGENTS_DIR, "builtin");
  const userAgents = loadAgentsFromDir(userDir, "user");
  const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

  if (scope === "user") return { agents: dedupeAgents(builtinAgents, userAgents), projectAgentsDir };
  if (scope === "project") return { agents: dedupeAgents(builtinAgents, projectAgents), projectAgentsDir };
  return { agents: dedupeAgents(builtinAgents, userAgents, projectAgents), projectAgentsDir };
}
