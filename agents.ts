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

import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project" | "builtin";

export const SUBAGENT_HIDE_BUILTIN_AGENTS_ENV = "PI_SUBAGENT_HIDE_BUILTIN_AGENTS";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	/** Whether this agent may be launched at delegation depth 1 (default: true). */
	firstLayer?: boolean;
	/** Whether this agent may be launched at the maximum delegation depth (default: true). */
	lastLayer?: boolean;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

const BUNDLED_AGENTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"agents",
);

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

function parseLayerSetting(
	value: unknown,
	field: "first-layer" | "last-layer",
	filePath: string,
): boolean {
	if (value === undefined) return true;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "enabled") return true;
		if (normalized === "disabled") return false;
	}
	console.warn(
		`[pi-subagent] Ignoring invalid ${field} field in "${filePath}". Expected enabled or disabled.`,
	);
	return true;
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
	if (typeof frontmatter.tools === "string") {
		const parsedTools = frontmatter.tools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (Array.isArray(frontmatter.tools)) {
		const parsedTools = frontmatter.tools
			.filter((t): t is string => typeof t === "string")
			.map((t) => t.trim())
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
		lastLayer: parseLayerSetting(frontmatter["last-layer"], "last-layer", filePath),
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
	const value = process.env[SUBAGENT_HIDE_BUILTIN_AGENTS_ENV]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Whether an agent is available to be launched at the requested child depth. */
export function isAgentEnabledAtLayer(
	agent: AgentConfig,
	targetDepth: number,
	maxDepth: number,
): boolean {
	if (targetDepth === 1 && agent.firstLayer === false) return false;
	if (targetDepth === maxDepth && agent.lastLayer === false) return false;
	return true;
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
