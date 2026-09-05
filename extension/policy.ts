import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, filterAdvertisedAgents, isAgentEnabledAtLayer } from "../agents.js";
import { parseBoolean, parseNonNegativeInt } from "../shared.js";
import { RESUME_SUBAGENTS_TOOL_NAME, SUBAGENT_TOOL_NAME } from "../types.js";

export const DEFAULT_MAX_DELEGATION_DEPTH = 3;

export const DEFAULT_PREVENT_CYCLE_DELEGATION = true;

export const DEFAULT_PROJECT_AGENT_CONFIRMATION = "ask";

export const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";

export const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";

export const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";

export const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";

export const SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV = "PI_SUBAGENT_CONFIRM_PROJECT_AGENTS";

export type ProjectAgentConfirmationSetting = "ask" | "never" | "session";

export type ProjectAgentApproval = "once" | "session" | "no";

export const DISABLE_RESUMABLE_SUBAGENTS_ENV = "DISABLE_RESUMABLE_SUBAGENTS";

export function resumableSubagentsDisabled(): boolean {
  return parseBoolean(process.env[DISABLE_RESUMABLE_SUBAGENTS_ENV]) === true;
}

export interface DelegationDepthConfig {
  currentDepth: number;
  maxDepth: number;
  canDelegate: boolean;
  ancestorAgentStack: string[];
  preventCycles: boolean;
}

export function parseProjectAgentConfirmationSetting(raw: unknown): ProjectAgentConfirmationSetting | null {
  if (raw === undefined) return DEFAULT_PROJECT_AGENT_CONFIRMATION;

  const parsedBoolean = parseBoolean(raw);
  if (parsedBoolean === true) return "ask";
  if (parsedBoolean === false) return "never";

  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["ask", "prompt", "once"].includes(normalized)) return "ask";
  if (["never", "allow", "skip"].includes(normalized)) return "never";
  if (["session", "remember", "yes-for-session"].includes(normalized)) {
    return "session";
  }
  return null;
}

export function resolveProjectAgentConfirmationSetting(raw: unknown): ProjectAgentConfirmationSetting {
  const parsed = parseProjectAgentConfirmationSetting(raw);
  if (raw !== undefined && parsed === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV}="${String(raw)}". Expected one of: true, false, ask, never, session.`,
    );
  }
  return parsed ?? DEFAULT_PROJECT_AGENT_CONFIRMATION;
}

export function getProjectAgentConfirmationSetting(): ProjectAgentConfirmationSetting {
  return resolveProjectAgentConfirmationSetting(process.env[SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV]);
}

export function parseAgentStack(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((value) => typeof value === "string")) return null;
  return parsed.map((value) => value.trim()).filter((value) => value.length > 0);
}

export function getMaxDepthFlagFromArgv(argv: string[]): string | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-max-depth") {
      return argv[i + 1] ?? "";
    }
    if (arg.startsWith("--subagent-max-depth=")) {
      return arg.slice("--subagent-max-depth=".length);
    }
  }
  return null;
}

export function getPreventCyclesFlagFromArgv(argv: string[]): string | boolean | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-prevent-cycles") {
      const maybeValue = argv[i + 1];
      if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
        return maybeValue;
      }
      return true;
    }
    if (arg === "--no-subagent-prevent-cycles") return false;
    if (arg.startsWith("--subagent-prevent-cycles=")) {
      return arg.slice("--subagent-prevent-cycles=".length);
    }
  }
  return null;
}

export function resolveDelegationDepthConfig(pi: ExtensionAPI): DelegationDepthConfig {
  const depthRaw = process.env[SUBAGENT_DEPTH_ENV];
  const parsedDepth = parseNonNegativeInt(depthRaw);
  if (depthRaw !== undefined && parsedDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_DEPTH_ENV}="${depthRaw}". Expected a non-negative integer.`,
    );
  }
  const currentDepth = parsedDepth ?? 0;

  const stackRaw = process.env[SUBAGENT_STACK_ENV];
  const ancestorAgentStack = parseAgentStack(stackRaw);
  if (stackRaw !== undefined && ancestorAgentStack === null) {
    console.warn(`[pi-subagent] Ignoring invalid ${SUBAGENT_STACK_ENV} value. Expected a JSON array of agent names.`);
  }

  const envMaxDepthRaw = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
  if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
    );
  }

  const argvFlagRaw = getMaxDepthFlagFromArgv(process.argv);
  const argvFlagMaxDepth = argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
  if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
    );
  }

  const runtimeFlagValue = pi.getFlag("subagent-max-depth");
  const runtimeFlagMaxDepth = typeof runtimeFlagValue === "string" ? parseNonNegativeInt(runtimeFlagValue) : null;
  if (argvFlagRaw === null && typeof runtimeFlagValue === "string" && runtimeFlagMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${runtimeFlagValue}". Expected a non-negative integer.`,
    );
  }

  const envPreventCyclesRaw = process.env[SUBAGENT_PREVENT_CYCLES_ENV];
  const envPreventCycles = parseBoolean(envPreventCyclesRaw);
  if (envPreventCyclesRaw !== undefined && envPreventCycles === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_PREVENT_CYCLES_ENV}="${envPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(process.argv);
  const argvPreventCycles =
    typeof argvPreventCyclesRaw === "boolean" ? argvPreventCyclesRaw : parseBoolean(argvPreventCyclesRaw);
  if (typeof argvPreventCyclesRaw === "string" && argvPreventCycles === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const runtimePreventCyclesRaw = pi.getFlag("subagent-prevent-cycles");
  const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
  if (argvPreventCyclesRaw === null && runtimePreventCyclesRaw !== undefined && runtimePreventCycles === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
    );
  }

  const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
  const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const preventCycles =
    argvPreventCycles ?? runtimePreventCycles ?? envPreventCycles ?? DEFAULT_PREVENT_CYCLE_DELEGATION;

  return {
    currentDepth,
    maxDepth,
    canDelegate: currentDepth < maxDepth,
    ancestorAgentStack: ancestorAgentStack ?? [],
    preventCycles,
  };
}

export function filterAgentsForCurrentLayer(
  agents: AgentConfig[],
  currentDepth: number,
  maxDepth: number,
): AgentConfig[] {
  const targetDepth = currentDepth + 1;
  return agents.filter((agent) => isAgentEnabledAtLayer(agent, targetDepth, maxDepth));
}

export function filterAgentsForPrompt(
  agents: AgentConfig[],
  currentDepth: number,
  maxDepth: number,
  delegationStack: string[],
  preventCycles: boolean,
): AgentConfig[] {
  return filterAdvertisedAgents(agents, currentDepth + 1, maxDepth, delegationStack, preventCycles);
}

export function formatAgentNames(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

export function getRequestedProjectAgents(agents: AgentConfig[], requestedNames: Set<string>): AgentConfig[] {
  return Array.from(requestedNames)
    .map((name) => agents.find((a) => a.name === name))
    .filter((a): a is AgentConfig => a?.source === "project");
}

export async function confirmProjectAgentsIfNeeded(
  projectAgents: AgentConfig[],
  projectAgentsDir: string | null,
  ctx: { ui: { select: (title: string, options: string[]) => Promise<string | undefined> } },
): Promise<ProjectAgentApproval> {
  if (projectAgents.length === 0) return "once";

  const names = projectAgents.map((a) => a.name).join(", ");
  const dir = projectAgentsDir ?? "(unknown)";
  const selection = await ctx.ui.select(
    `Run project-local agents?\nAgents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
    ["Yes once", "Yes for this session", "No"],
  );

  if (selection === "Yes once") return "once";
  if (selection === "Yes for this session") return "session";
  return "no";
}

export function getProjectAgentSessionKey(projectAgentsDir: string | null): string {
  return projectAgentsDir ?? "(unknown-project-agents-dir)";
}

export function ensureSubagentToolActive(pi: ExtensionAPI): void {
  const activeTools = pi.getActiveTools();
  const wanted = resumableSubagentsDisabled() ? [SUBAGENT_TOOL_NAME] : [SUBAGENT_TOOL_NAME, RESUME_SUBAGENTS_TOOL_NAME];
  const missing = wanted.filter((tool) => !activeTools.includes(tool));
  if (missing.length > 0) {
    pi.setActiveTools([...activeTools, ...missing]);
  }
}

export function isRpcMode(argv: string[]): boolean {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1] === "rpc") return true;
    if (arg === "--mode=rpc") return true;
  }
  return false;
}

export function hasCliInitialPrompt(argv: string[]): boolean {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--print") return true;
  }
  return false;
}

export function isStreamingSteerInput(event: { streamingBehavior?: string }, ctx: { isIdle: () => boolean }): boolean {
  // Newer Pi versions provide this directly. Undefined means the input was
  // submitted while idle; "followUp" means it is queued for the next turn.
  // Only "steer" should be intercepted for subagent broadcast routing.
  if (Object.prototype.hasOwnProperty.call(event ?? {}, "streamingBehavior")) {
    return event.streamingBehavior === "steer";
  }

  // Backward compatibility for older Pi versions that emitted `input` without
  // delivery metadata: non-idle input was treated as a steering message.
  return !ctx.isIdle();
}
