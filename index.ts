/**
 * Pi Subagent Extension
 *
 * Delegates tasks to specialized subagents running as isolated `pi` processes.
 *
 * The tool always accepts a `tasks` array:
 *   - One task: treated as a single-agent delegation.
 *   - Multiple tasks: treated as a parallel delegation.
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  fauxToolCall,
  lazyStream,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents, isAgentEnabledAtLayer } from "./agents.js";
import { loadPiSubagentsConfig } from "./config.js";
import {
  allocateSubagentNames,
  clearResumeActive,
  commitFork,
  findAncestorNamesFile,
  findPersistedNamesIdentity,
  forkSessionInto,
  getInheritedNamesFile,
  getNamesFilePath,
  markResumeActive,
  readNamesRegistry,
  resolveResumeTarget,
  updateNameRecord,
  SUBAGENT_NAMES_CUSTOM_TYPE,
} from "./names.js";
import {
  recordToolCallStart,
  renderCall,
  renderResult,
  renderResumeCall,
  setBroadcastNumberingActive,
} from "./render.js";
import { runAgentSubprocess, executeParallelSubprocess, type RunningSubagentHandle } from "./runner.js";
import {
  SUBAGENT_RESUME_DISABLE_ENV,
  SUBAGENT_RESUME_PROMPT_ENV,
  branchEntries,
  buildSubagentSessionDir,
  findLatestResumableSubagentCalls,
  getDefaultSubagentSessionRoot,
  isFinishedResult,
  parseBooleanEnv,
  sameTasks,
  type ResumableSubagentCall,
} from "./resume.js";
import {
  DEFAULT_MAX_PARALLEL_TASKS,
  RESUME_MODEL_ID,
  RESUME_PROVIDER,
  SUBAGENT_MAX_PARALLEL_TASKS_ENV,
  parseBoolean,
  parseNonNegativeInt,
} from "./shared.js";

import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  type SubagentUsageSummary,
  DEFAULT_DELEGATION_MODE,
  buildLiveSubagentDetails,
  buildSubagentDetails,
  getFinalOutput,
  getNestedSubagentResults,
  isResultError,
  isSubagentDetails,
  isSubagentToolName,
  RESUME_SUBAGENTS_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  emptyUsage,
  addUsage,
  emptyUsageSummary,
  addUsageSummary,
  usageSummaryToUsageStats,
  usageSummaryFromUsage,
} from "./types.js";
import { formatCombinedUsageStatusLine } from "./tree.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const DEFAULT_PROJECT_AGENT_CONFIRMATION = "ask";
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV = "PI_SUBAGENT_CONFIRM_PROJECT_AGENTS";

const BASE_SUBAGENTS_TOOL_DESCRIPTION = [
  "Delegate work to specialized subagents running as isolated pi processes.",
  "",
  "Pass a `tasks` array. Every task in the same call runs IN PARALLEL.",
  "  - 1 task  -> single delegation",
  "  - N tasks -> all N run concurrently in one call",
  "",
  "For sequential work (task B depends on task A's output), make separate",
  "tool calls one after another. Do NOT put dependent tasks in the same array.",
  "",
  'Single:   { tasks: [{ agent: "writer", task: "Rewrite README.md" }] }',
  'Parallel: { tasks: [{ agent: "writer", task: "..." }, { agent: "tester", task: "..." }] }',
].join("\n");

const SUBAGENT_USAGE_GUIDANCE =
  "Be careful with subagents: use them when the user explicitly asks or when they are truly necessary, because they are expensive. Good cases: running several exploration tasks in parallel, solving several tasks in parallel, or delegating several large tasks to separate subagents. Bad cases (don't do this): creating many nested subagents with similar tasks, using sequential subagents for simple short tasks, running a subagent just to read a file or execute a bash command, or delegating work that does not need a team or parallel execution (unless the user asked you to).";

export function getSubagentsToolDescription(): string {
  return `${BASE_SUBAGENTS_TOOL_DESCRIPTION}\n\n${SUBAGENT_USAGE_GUIDANCE}`;
}

function sameToolPrompts(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key]);
}

type ProjectAgentConfirmationSetting = "ask" | "never" | "session";
type ProjectAgentApproval = "once" | "session" | "no";

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
  agent: Type.String({
    description: "Name of an available agent (must match exactly)",
  }),
  task: Type.String({
    description:
      "Task description for this delegated run. Include all required context; the subagent receives only this prompt.",
  }),
}, { additionalProperties: false });

const SubagentParams = Type.Object({
  tasks: Type.Array(TaskItem, {
    minItems: 1,
    description:
      "Array of {agent, task} objects. One task behaves like a single-agent delegation; multiple tasks run concurrently.",
  }),
}, { additionalProperties: false });

const ResumeItem = Type.Object({
  subagent: Type.String({
    description: "Unique subagent name returned by a previous subagents run (e.g. code-writer-01)",
  }),
  task: Type.String({
    description: "New task for the resumed subagent. It keeps its previous context.",
  }),
}, { additionalProperties: false });

// The single bare-object form is tolerated for robustness but deliberately
// not documented: the description only advertises the array form.
const ResumeSubagentsParams = Type.Object({
  resumes: Type.Union(
    [
      Type.Array(ResumeItem, { minItems: 1 }),
      ResumeItem,
    ],
    {
      description:
        "Array of {subagent, task} objects. Each named subagent is resumed in parallel with its new task.",
    },
  ),
}, { additionalProperties: false });

/**
 * Accept both `resumes: [{...}]` and a single bare `resumes: {...}` object.
 * Also tolerates the legacy {name, prompt} field names from older sessions.
 */
function normalizeResumes(raw: unknown): Array<{ name: string; task: string }> {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const normalized: Array<{ name: string; task: string }> = [];
  for (const item of items as any[]) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.subagent === "string" ? item.subagent : typeof item.name === "string" ? item.name : undefined;
    const task = typeof item.task === "string" ? item.task : typeof item.prompt === "string" ? item.prompt : undefined;
    if (name !== undefined && task !== undefined) normalized.push({ name, task });
  }
  return normalized;
}

/** Resumable named subagents are on by default; set to 1/true/on to disable. */
const DISABLE_RESUMABLE_SUBAGENTS_ENV = "DISABLE_RESUMABLE_SUBAGENTS";

function resumableSubagentsDisabled(): boolean {
  return parseBoolean(process.env[DISABLE_RESUMABLE_SUBAGENTS_ENV]) === true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DelegationDepthConfig {
  currentDepth: number;
  maxDepth: number;
  canDelegate: boolean;
  ancestorAgentStack: string[];
  preventCycles: boolean;
}

function parseProjectAgentConfirmationSetting(
  raw: unknown,
): ProjectAgentConfirmationSetting | null {
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

function resolveProjectAgentConfirmationSetting(
  raw: unknown,
): ProjectAgentConfirmationSetting {
  const parsed = parseProjectAgentConfirmationSetting(raw);
  if (raw !== undefined && parsed === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV}="${String(raw)}". Expected one of: true, false, ask, never, session.`,
    );
  }
  return parsed ?? DEFAULT_PROJECT_AGENT_CONFIRMATION;
}

function getProjectAgentConfirmationSetting(): ProjectAgentConfirmationSetting {
  return resolveProjectAgentConfirmationSetting(
    process.env[SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV],
  );
}

function parseAgentStack(raw: unknown): string[] | null {
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
  return parsed
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getMaxDepthFlagFromArgv(argv: string[]): string | null {
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

function getPreventCyclesFlagFromArgv(
  argv: string[],
): string | boolean | null {
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

function resolveDelegationDepthConfig(pi: ExtensionAPI): DelegationDepthConfig {
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
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_STACK_ENV} value. Expected a JSON array of agent names.`,
    );
  }

  const envMaxDepthRaw = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
  if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
    );
  }

  const argvFlagRaw = getMaxDepthFlagFromArgv(process.argv);
  const argvFlagMaxDepth =
    argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
  if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
    );
  }

  const runtimeFlagValue = pi.getFlag("subagent-max-depth");
  const runtimeFlagMaxDepth =
    typeof runtimeFlagValue === "string"
      ? parseNonNegativeInt(runtimeFlagValue)
      : null;
  if (
    argvFlagRaw === null &&
    typeof runtimeFlagValue === "string" &&
    runtimeFlagMaxDepth === null
  ) {
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
    typeof argvPreventCyclesRaw === "boolean"
      ? argvPreventCyclesRaw
      : parseBoolean(argvPreventCyclesRaw);
  if (
    typeof argvPreventCyclesRaw === "string" &&
    argvPreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const runtimePreventCyclesRaw = pi.getFlag("subagent-prevent-cycles");
  const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
  if (
    argvPreventCyclesRaw === null &&
    runtimePreventCyclesRaw !== undefined &&
    runtimePreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
    );
  }

  const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
  const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const preventCycles =
    argvPreventCycles ??
    runtimePreventCycles ??
    envPreventCycles ??
    DEFAULT_PREVENT_CYCLE_DELEGATION;

  return {
    currentDepth,
    maxDepth,
    canDelegate: currentDepth < maxDepth,
    ancestorAgentStack: ancestorAgentStack ?? [],
    preventCycles,
  };
}

function makeDetailsFactory(
  projectAgentsDir: string | null,
  delegationMode: DelegationMode,
) {
  return (mode: "single" | "parallel") => {
    const makeDetails = (results: SingleResult[]): SubagentDetails =>
      buildSubagentDetails(mode, delegationMode, projectAgentsDir, results);
    makeDetails.live = (results: SingleResult[]): SubagentDetails =>
      buildLiveSubagentDetails(mode, delegationMode, projectAgentsDir, results);
    return makeDetails;
  };
}

function filterAgentsForCurrentLayer(
  agents: AgentConfig[],
  currentDepth: number,
  maxDepth: number,
): AgentConfig[] {
  const targetDepth = currentDepth + 1;
  return agents.filter((agent) => isAgentEnabledAtLayer(agent, targetDepth, maxDepth));
}

function formatAgentNames(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

function liveDetailsSignature(details: SubagentDetails): string {
  return JSON.stringify(details.results.map((result) => ({
    agent: result.agent,
    task: result.task ?? "",
  })));
}

function collectLiveUsageSummary(details: SubagentDetails): SubagentUsageSummary {
  const summary = emptyUsageSummary();
  for (const result of details.results) {
    addUsageSummary(summary, usageSummaryFromUsage(result.usage));

    const completedNested = getNestedSubagentResults(result.messages ?? []);
    const completedNestedIds = new Set<string>();
    const completedNestedSignatureCounts = new Map<string, number>();
    for (const nested of completedNested) {
      if (nested.toolCallId) completedNestedIds.add(nested.toolCallId);
      const signature = liveDetailsSignature(nested.details);
      completedNestedSignatureCounts.set(
        signature,
        (completedNestedSignatureCounts.get(signature) ?? 0) + 1,
      );
      addUsageSummary(
        summary,
        nested.details.usageSummary ?? collectLiveUsageSummary(nested.details),
      );
    }

    for (const [liveToolCallId, liveNested] of Object.entries(result.liveNestedSubagents ?? {})) {
      if (!isSubagentDetails(liveNested)) continue;
      // Prefer durable completed toolResult messages over matching live progress.
      // Some Pi versions key live progress differently than final tool results,
      // so also de-dupe by requested child agent/task signature as a multiset.
      if (completedNestedIds.has(liveToolCallId)) continue;
      const signature = liveDetailsSignature(liveNested);
      const completedSignatureCount = completedNestedSignatureCounts.get(signature) ?? 0;
      if (completedSignatureCount > 0) {
        completedNestedSignatureCounts.set(signature, completedSignatureCount - 1);
        continue;
      }
      addUsageSummary(summary, collectLiveUsageSummary(liveNested));
    }
  }
  return summary;
}

function collectCombinedUsageStatusLine(
  ctx: any,
  liveSummaries: SubagentUsageSummary[] = [],
): string | undefined {
  const entries = typeof ctx?.sessionManager?.getEntries === "function" || typeof ctx?.sessionManager?.getBranch === "function"
    ? branchEntries(ctx)
    : [];
  if (entries.length === 0 && liveSummaries.length === 0) return undefined;

  const parentUsage = emptyUsage();
  const subagents = emptyUsageSummary();
  for (const entry of entries as any[]) {
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;
    if (msg.role === "assistant" && msg.provider !== RESUME_PROVIDER) {
      const usage = msg.usage;
      if (usage) {
        parentUsage.input += usage.input || 0;
        parentUsage.output += usage.output || 0;
        parentUsage.cacheRead += usage.cacheRead || 0;
        parentUsage.cacheWrite += usage.cacheWrite || 0;
        parentUsage.cost += typeof usage.cost === "number" ? usage.cost : usage.cost?.total || 0;
        parentUsage.turns += 1;
      }
    }
    if (msg.role === "toolResult" && isSubagentToolName(msg.toolName) && isSubagentDetails(msg.details)) {
      addUsageSummary(
        subagents,
        msg.details.usageSummary ?? usageSummaryFromUsage(msg.details.aggregatedUsage),
      );
    }
  }
  for (const liveSummary of liveSummaries) {
    addUsageSummary(subagents, liveSummary);
  }
  const subagentUsage = usageSummaryToUsageStats(subagents) ?? emptyUsage();
  addUsage(parentUsage, subagentUsage);
  return formatCombinedUsageStatusLine(parentUsage, subagents.subagentCount);
}

function getCycleViolations(
  requestedNames: Set<string>,
  ancestorAgentStack: string[],
): string[] {
  if (requestedNames.size === 0 || ancestorAgentStack.length === 0) return [];
  const stackSet = new Set(ancestorAgentStack);
  return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

/** Get project-local agents referenced by the current request. */
function getRequestedProjectAgents(
  agents: AgentConfig[],
  requestedNames: Set<string>,
): AgentConfig[] {
  return Array.from(requestedNames)
    .map((name) => agents.find((a) => a.name === name))
    .filter((a): a is AgentConfig => a?.source === "project");
}

/**
 * Prompt the user to confirm project-local agents if needed.
 */
async function confirmProjectAgentsIfNeeded(
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

function getProjectAgentSessionKey(projectAgentsDir: string | null): string {
  return projectAgentsDir ?? "(unknown-project-agents-dir)";
}

function ensureSubagentToolActive(pi: ExtensionAPI): void {
  const activeTools = pi.getActiveTools();
  const wanted = resumableSubagentsDisabled()
    ? [SUBAGENT_TOOL_NAME]
    : [SUBAGENT_TOOL_NAME, RESUME_SUBAGENTS_TOOL_NAME];
  const missing = wanted.filter((tool) => !activeTools.includes(tool));
  if (missing.length > 0) {
    pi.setActiveTools([...activeTools, ...missing]);
  }
}

function isRpcMode(argv: string[]): boolean {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode" && argv[i + 1] === "rpc") return true;
    if (arg === "--mode=rpc") return true;
  }
  return false;
}

function hasCliInitialPrompt(argv: string[]): boolean {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--print") return true;
  }
  return false;
}

function isStreamingSteerInput(event: any, ctx: { isIdle: () => boolean }): boolean {
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

const SUBAGENT_FALLBACK_MODEL_ENV = "PI_SUBAGENT_FALLBACK_MODEL";
const RESUME_INTERACTIVE_DELAY_MS = 50;

type SyntheticResumeState = {
  plans: ResumableSubagentCall[];
  phase: "tool" | "final";
  trigger: "resumePrompt" | "nextRequest";
};

// Model definition for the synthetic subagent-resume provider. Shared between
// the faux core (which produces the canned assistant turn) and the provider
// registration below.
const RESUME_MODEL_DEF = {
  id: RESUME_MODEL_ID,
  name: "Pi Subagent Resume",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // Keep this large so Pi's pre-prompt auto-compaction does not invoke the
  // synthetic provider before the visible resume prompt is appended. That would
  // consume the tool-call phase during compaction and the real resume turn
  // would only see the final text message.
  contextWindow: 1_000_000,
  maxTokens: 16,
};

function getMessageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function isSyntheticResumePrompt(context: any, taskCount: number): boolean {
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  return getMessageText(lastUser).trim() === `Resuming ${taskCount} subagents...`;
}

function formatModelFlag(model: any): string | undefined {
  if (!model?.id || !model?.provider) return undefined;
  return `${model.provider}/${model.id}`;
}

function findLastNonResumeModel(ctx: any): any | undefined {
  const entries = branchEntries(ctx);

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "model_change") continue;
    const provider = entry.provider;
    const modelId = entry.modelId;
    if (provider === RESUME_PROVIDER) continue;
    if (typeof provider !== "string" || typeof modelId !== "string") continue;
    const model = ctx.modelRegistry?.find?.(provider, modelId);
    if (model) return model;
  }
  return undefined;
}

function getEnvFallbackModel(ctx: any): any | undefined {
  const raw = process.env[SUBAGENT_FALLBACK_MODEL_ENV];
  if (!raw || !raw.includes("/")) return undefined;
  const [provider, ...idParts] = raw.split("/");
  const id = idParts.join("/");
  if (!provider || !id) return undefined;
  return ctx.modelRegistry?.find?.(provider, id);
}

function getRestorableModel(ctx: any): any | undefined {
  if (ctx.model?.provider && ctx.model.provider !== RESUME_PROVIDER) return ctx.model;
  return findLastNonResumeModel(ctx) ?? getEnvFallbackModel(ctx);
}

/**
 * Pick the parent model inherited by a subagent launch.
 *
 * A normal tool call was emitted by the current model, so that model is the
 * authoritative choice. Looking backward in the session is only appropriate
 * while our own synthetic resume model is active (or no current model exists).
 */
export function selectParentModelForSubagent(
  currentModel: any | undefined,
  modelBeforeSynthetic: any | undefined,
  historicalRealModel: any | undefined,
  lastRestorableModel: any | undefined,
): any | undefined {
  if (currentModel?.provider && currentModel.provider !== RESUME_PROVIDER) {
    return currentModel;
  }
  return modelBeforeSynthetic ?? historicalRealModel ?? lastRestorableModel;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let configuredToolPrompts = loadPiSubagentsConfig().toolPrompts;
  let refreshRegisteredToolPrompts: ((cwd: string, includeProject: boolean) => void) | undefined;
  let resumeModelRegistry: any | undefined;
  let lastRestorableModel: any | undefined;
  let latestSessionCtx: any | undefined;
  let pendingInteractiveResumePrompt: string | null = null;
  let lifecycleGeneration = 0;
  let sessionActive = false;
  const scheduledTasks = new Set<ReturnType<typeof setTimeout>>();
  const resumeState: SyntheticResumeState = {
    plans: [],
    phase: "tool",
    trigger: "resumePrompt",
  };

  function clearSyntheticResumeState(): void {
    resumeState.plans = [];
    resumeState.phase = "tool";
    resumeState.trigger = "resumePrompt";
  }

  function getParentModelForSubagent(ctx: any): any | undefined {
    const currentModel = ctx?.model;
    // Avoid historical lookup during normal calls: the current assistant
    // response is the one that emitted the subagents tool call.
    if (currentModel?.provider && currentModel.provider !== RESUME_PROVIDER) {
      return currentModel;
    }
    return selectParentModelForSubagent(
      currentModel,
      modelToRestoreAfterResume,
      findLastNonResumeModel(ctx) ?? getEnvFallbackModel(ctx),
      lastRestorableModel,
    );
  }

  function scheduleSessionTask(callback: () => void, delayMs: number): void {
    const expectedGeneration = lifecycleGeneration;
    const timer = setTimeout(() => {
      scheduledTasks.delete(timer);
      if (!sessionActive || expectedGeneration !== lifecycleGeneration) return;
      callback();
    }, delayMs);
    scheduledTasks.add(timer);
  }

  function mergeProviderHeaders(
    base: Record<string, string | null> | undefined,
    override: Record<string, string | null> | undefined,
  ): Record<string, string | null> | undefined {
    const merged = new Map<string, [string, string | null]>();
    for (const headers of [base, override]) {
      for (const [name, value] of Object.entries(headers ?? {})) {
        const key = name.toLowerCase();
        if (value === null) merged.delete(key);
        else merged.set(key, [name, value]);
      }
    }
    return merged.size > 0 ? Object.fromEntries(merged.values()) : undefined;
  }

  function streamWithRealModelFallback(
    context: any,
    options: any,
    fallback: any,
    expectedGeneration = lifecycleGeneration,
  ) {
    if (!fallback || !resumeModelRegistry) return null;

    // Use pi 0.81's effective Provider instead of dispatching on model.api.
    // This preserves custom provider streams, provider composition, dynamic
    // auth base URLs, provider-scoped env, and future/custom API identifiers.
    return lazyStream(fallback, async () => {
      if (!sessionActive || expectedGeneration !== lifecycleGeneration) {
        throw new Error("Subagent resume fallback was cancelled by session replacement.");
      }
      const provider = resumeModelRegistry.getProvider?.(fallback.provider);
      if (!provider || provider.id === RESUME_PROVIDER) {
        throw new Error(`Subagent resume fallback provider is unavailable: ${fallback.provider}.`);
      }
      const [providerResolution, modelResolution] = await Promise.all([
        resumeModelRegistry.getProviderAuth?.(fallback.provider),
        resumeModelRegistry.getApiKeyAndHeaders?.(fallback),
      ]);
      if (!sessionActive || expectedGeneration !== lifecycleGeneration) {
        throw new Error("Subagent resume fallback was cancelled by session replacement.");
      }
      if (!providerResolution || !modelResolution?.ok) {
        throw new Error(
          modelResolution?.error ?? `Provider is not configured: ${fallback.provider}`,
        );
      }
      const providerAuth = providerResolution.auth ?? {};
      const requestModel = providerAuth.baseUrl
        ? { ...fallback, baseUrl: providerAuth.baseUrl }
        : fallback;
      const requestOptions = {
        ...options,
        // Model-aware resolution includes configured/model headers. Never
        // forward the synthetic provider's no-op credential.
        apiKey: modelResolution.apiKey,
        headers: mergeProviderHeaders(modelResolution.headers, options?.headers),
        env: {
          ...(providerResolution.env ?? {}),
          ...(modelResolution.env ?? {}),
          ...(options?.env ?? {}),
        },
      };
      return provider.streamSimple(requestModel, context, requestOptions);
    });
  }

  async function restoreVisibleModelForResume(
    expectedGeneration = lifecycleGeneration,
  ): Promise<any | undefined> {
    if (!sessionActive || expectedGeneration !== lifecycleGeneration) return undefined;
    const restore = modelToRestoreAfterResume ?? lastRestorableModel;
    if (!restore) return undefined;
    lastRestorableModel = restore;
    if (latestSessionCtx?.model?.provider === RESUME_PROVIDER) {
      try {
        await pi.setModel(restore);
      } catch (err) {
        if (sessionActive && expectedGeneration === lifecycleGeneration) {
          console.error("[pi-subagent] Failed to restore real model during resume:", err);
        }
      }
    }
    return restore;
  }

  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 3).",
    type: "string",
  });
  pi.registerFlag("subagent-prevent-cycles", {
    description:
      "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });

  // The synthetic resume provider injects the resumed subagent tool call(s) as
  // a canned assistant turn using pi-ai's first-class faux provider, instead of
  // hand-rolling an AssistantMessageEventStream.
  const resumeCore = createFauxCore({
    api: "openai-responses",
    provider: RESUME_PROVIDER,
    models: [RESUME_MODEL_DEF],
  });

  const resumeProvider = createProvider({
    id: RESUME_PROVIDER,
    name: "Pi Subagent Resume",
    auth: {
      apiKey: {
        name: "Internal synthetic resume provider",
        async resolve() {
          return {
            auth: { apiKey: "pi-subagent-resume-noop-key" },
            source: "internal synthetic provider",
          };
        },
      },
    },
    models: resumeCore.models,
    api: {
      stream: resumeCore.stream,
      streamSimple: (model, context, options) => {
      const state = resumeState;
      const expectedGeneration = lifecycleGeneration;
      const discoveredPlans = state.plans.length > 0
        ? state.plans
        : pendingResumePlans.length > 0
          ? pendingResumePlans
          : latestSessionCtx
            ? findLatestResumableSubagentCalls(latestSessionCtx)
            : [];
      if (discoveredPlans.length > 0 && state.plans.length === 0) {
        state.plans = [...discoveredPlans];
        pendingResumePlans = [...discoveredPlans];
      }
      const plans = discoveredPlans;
      const totalTaskCount = plans.reduce((sum, plan) => sum + plan.tasks.length, 0);
      const phase = state.phase;
      const triggerMatches =
        state.trigger === "nextRequest" ||
        (totalTaskCount > 0 ? isSyntheticResumePrompt(context, totalTaskCount) : false);

      // Happy path: emit the resumed subagent tool call(s) as one canned
      // assistant turn. The faux core streams the message we build with
      // `fauxToolCall`/`fauxAssistantMessage` as proper stream events.
      if (plans.length > 0 && phase === "tool" && triggerMatches) {
        state.phase = "final";
        const toolCalls = plans.map((plan, index) =>
          fauxToolCall(
            SUBAGENT_TOOL_NAME,
            { tasks: plan.tasks },
            { id: `resume_subagent_${Date.now()}_${index}` },
          ),
        );
        resumeCore.setResponses([
          () => fauxAssistantMessage(toolCalls, { stopReason: "toolUse" }),
        ]);
        const stream = resumeCore.streamSimple(model, context, options);
        // Restore the real model once the injected turn has fully streamed so
        // the TUI does not appear stuck on `pi-subagent-resume` while the
        // subagent tool execution is still running.
        void stream
          .result()
          .catch(() => {})
          .finally(() => {
            void restoreVisibleModelForResume(expectedGeneration);
          });
        return stream;
      }

      // Defensive: the synthetic model is still active but this is not the
      // injection turn (e.g. a request raced ahead of the model restore).
      // Forward the request to the real fallback model instead.
      if (phase === "final") {
        const delegated = streamWithRealModelFallback(
          context,
          options,
          modelToRestoreAfterResume ?? lastRestorableModel,
          expectedGeneration,
        );
        if (delegated) {
          void restoreVisibleModelForResume(expectedGeneration);
          return delegated;
        }
      }

      const fallback = streamWithRealModelFallback(
        context,
        options,
        modelToRestoreAfterResume ?? lastRestorableModel,
        expectedGeneration,
      );
      if (fallback) {
        void restoreVisibleModelForResume(expectedGeneration);
        return fallback;
      }

      // No real model to fall back to: surface a clear error turn.
      if (!(plans.length > 0 && phase === "tool")) {
        state.plans = [];
        state.phase = "tool";
      }
      const errorText =
        "Subagent resume failed: synthetic resume provider was invoked without a valid resume plan.";
      resumeCore.setResponses([
        () => fauxAssistantMessage([], { stopReason: "error", errorMessage: errorText }),
      ]);
      return resumeCore.streamSimple(model, context, options);
      },
    },
  });
  pi.registerProvider(resumeProvider);

  const depthConfig = resolveDelegationDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;
  const maxParallelTasks =
    parseNonNegativeInt(process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV]) ??
    DEFAULT_MAX_PARALLEL_TASKS;

  let discoveredAgents: AgentConfig[] = [];
  let currentSessionId = "ephemeral";
  let currentSubagentSessionRoot = "";
  let currentNamesFile = "";
  /** Stable ownership/fork key for this session's delegation tree position. */
  let currentOwnerId = "ephemeral";
  let pendingResumePlans: ResumableSubagentCall[] = [];
  let modelToRestoreAfterResume: any | undefined;
  const approvedProjectAgentDirsForSession = new Set<string>();
  const activeSubagents = new Map<number, { agent: string; task: string; taskIndex: number; handle: RunningSubagentHandle; name?: string }>();
  /** Names with a resume in flight in this process (same-process race guard). */
  const activeResumeNames = new Set<string>();
  const activeSubagentUsageSummaries = new Map<string, SubagentUsageSummary>();
  const latestBroadcastTargets = {
    all: [] as BroadcastTarget[],
    youngest: [] as BroadcastTarget[],
  };
  let nextActiveSubagentId = 1;

  /**
   * Build a lightweight version of SubagentDetails for live progress bubbling.
   *
   * Full message histories can be very large in long agent trees. For live TUI
   * rendering we only need subagent tool-call structure, nested subagent
   * results, live logs, metadata, and usage counters. Text conversations are
   * intentionally omitted; final durable results still arrive via normal
   * tool_result_end messages.
   */
  function slimDetailsForProgress(details: SubagentDetails): SubagentDetails {
    const slimResult = (result: SingleResult): SingleResult => {
      const slimMessages = result.messages
        .map((message: any) => {
          if (message?.role === "assistant" && Array.isArray(message.content)) {
            const subagentCalls = message.content.filter(
              (part: any) => part?.type === "toolCall" && isSubagentToolName(part?.name),
            );
            return subagentCalls.length > 0
              ? { ...message, content: subagentCalls }
              : null;
          }
          if (message?.role === "toolResult" && isSubagentToolName(message.toolName)) {
            return isSubagentDetails(message.details)
              ? { ...message, details: slimDetailsForProgress(message.details) }
              : message;
          }
          return null;
        })
        .filter(Boolean) as SingleResult["messages"];

      const liveNestedSubagents = result.liveNestedSubagents
        ? Object.fromEntries(
            Object.entries(result.liveNestedSubagents).map(([nestedToolCallId, nested]) => [
              nestedToolCallId,
              slimDetailsForProgress(nested),
            ]),
          )
        : undefined;

      return {
        ...result,
        messages: slimMessages,
        stderr: result.stderr ? result.stderr.slice(-1000) : "",
        liveLog: [...(result.liveLog ?? [])],
        liveNestedSubagents,
      };
    };

    return {
      ...details,
      results: details.results.map(slimResult),
    };
  }

  function emitNestedProgressToParent(toolCallId: string, details: SubagentDetails): void {
    if (currentDepth <= 0) return;
    try {
      process.stdout.write(`${JSON.stringify({
        type: "subagent_progress",
        toolCallId,
        details: slimDetailsForProgress(details),
      })}\n`);
    } catch {
      // Best-effort only. Normal final tool_result_end still carries the durable result.
    }
  }

  const BROADCAST_STEER_PREFIX = "__PI_SUBAGENT_BROADCAST_STEER__";

  interface BroadcastTarget {
    display: string;
    topLevelId: number;
    restPath: number[];
  }

  interface ParsedBroadcastSelection {
    targets: BroadcastTarget[];
    errors: string[];
  }

  function parseBroadcastPath(raw: string): number[] | null {
    const parts = raw.trim().split(".");
    if (parts.length === 0) return null;
    const path: number[] = [];
    for (const part of parts) {
      if (!/^\d+$/.test(part)) return null;
      const value = Number(part);
      if (!Number.isSafeInteger(value) || value < 1) return null;
      path.push(value);
    }
    return path;
  }

  function parseBroadcastSelection(input: string, available: number[]): ParsedBroadcastSelection {
    const normalized = input.trim().toUpperCase();
    if (normalized === "ALL") {
      return {
        targets: available.map((id) => ({ display: String(id), topLevelId: id, restPath: [] })),
        errors: [],
      };
    }

    const errors: string[] = [];
    const targetMap = new Map<string, BroadcastTarget>();
    for (const rawPart of input.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;

      if (part.includes("-")) {
        const [startRaw, endRaw, extra] = part.split("-").map((p) => p.trim());
        const startPath = parseBroadcastPath(startRaw);
        const endPath = parseBroadcastPath(endRaw);
        if (extra !== undefined || !startPath || !endPath || startPath.length !== 1 || endPath.length !== 1) {
          errors.push(`Invalid range "${part}". Use top-level ranges like 1-3.`);
          continue;
        }
        const start = startPath[0];
        const end = endPath[0];
        for (let id = Math.min(start, end); id <= Math.max(start, end); id++) {
          if (!available.includes(id)) {
            errors.push(`Subagent ${id} is not running.`);
            continue;
          }
          targetMap.set(String(id), { display: String(id), topLevelId: id, restPath: [] });
        }
        continue;
      }

      const path = parseBroadcastPath(part);
      if (!path) {
        errors.push(`Invalid target "${part}". Use ALL, numbers, paths, or top-level ranges (e.g. 1, 2, 4.1, 1-3).`);
        continue;
      }
      const [topLevelId, ...restPath] = path;
      if (!available.includes(topLevelId)) {
        errors.push(`Subagent ${topLevelId} is not running.`);
        continue;
      }
      const display = path.join(".");
      targetMap.set(display, { display, topLevelId, restPath });
    }

    return {
      targets: Array.from(targetMap.values()).sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true })),
      errors,
    };
  }

  function encodeNestedBroadcast(message: string, path: number[]): string {
    return `${BROADCAST_STEER_PREFIX}${JSON.stringify({ path, message })}`;
  }

  function decodeNestedBroadcast(text: string): { path: number[]; message: string } | null {
    if (!text.startsWith(BROADCAST_STEER_PREFIX)) return null;
    try {
      const parsed = JSON.parse(text.slice(BROADCAST_STEER_PREFIX.length));
      if (!Array.isArray(parsed?.path) || !parsed.path.every((n: unknown) => Number.isSafeInteger(n) && (n as number) >= 1)) return null;
      if (typeof parsed?.message !== "string") return null;
      return { path: parsed.path, message: parsed.message };
    } catch {
      return null;
    }
  }

  function extractPendingSubagentTaskCounts(result: SingleResult): number[] {
    const messages = Array.isArray((result as any).messages) ? (result as any).messages : [];
    const completedToolCallIds = new Set(getNestedSubagentResults(messages).map((nested) => nested.toolCallId));
    const counts: number[] = [];
    for (const message of messages) {
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (part?.type !== "toolCall" || !isSubagentToolName(part?.name)) continue;
        const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : typeof part.id === "string" ? part.id : undefined;
        if (toolCallId && completedToolCallIds.has(toolCallId)) continue;
        const rawResumes = part.arguments?.resumes;
        const tasks = Array.isArray(part.arguments?.tasks)
          ? part.arguments.tasks
          : Array.isArray(rawResumes)
            ? rawResumes
            : rawResumes && typeof rawResumes === "object"
              ? [rawResumes]
              : [];
        if (tasks.length > 0) counts.push(tasks.length);
      }
    }
    return counts;
  }

  function collectRunningBroadcastTargetsFromResult(
    result: SingleResult,
    path: number[],
    targets: { all: BroadcastTarget[]; youngest: BroadcastTarget[] },
  ): boolean {
    const nestedRunningPaths: number[][] = [];

    for (const nested of getNestedSubagentResults(result.messages)) {
      if (!isSubagentDetails(nested.details)) continue;
      nested.details.results.forEach((child, index) => {
        const childPath = [...path, index + 1];
        if (collectRunningBroadcastTargetsFromResult(child, childPath, targets)) {
          nestedRunningPaths.push(childPath);
        }
      });
    }

    if (result.exitCode === -1) {
      for (const taskCount of extractPendingSubagentTaskCounts(result)) {
        for (let i = 1; i <= taskCount; i++) {
          const childPath = [...path, i];
          const [topLevelId, ...restPath] = childPath;
          targets.all.push({ display: childPath.join("."), topLevelId, restPath });
          targets.youngest.push({ display: childPath.join("."), topLevelId, restPath });
          nestedRunningPaths.push(childPath);
        }
      }
    }

    const isRunning = result.exitCode === -1;
    if (!isRunning) return nestedRunningPaths.length > 0;

    const [topLevelId, ...restPath] = path;
    const self = { display: path.join("."), topLevelId, restPath };
    targets.all.push(self);
    if (nestedRunningPaths.length === 0) targets.youngest.push(self);
    return true;
  }

  function updateLatestBroadcastTargets(details: SubagentDetails | undefined, topLevelBaseId = 1): void {
    latestBroadcastTargets.all = [];
    latestBroadcastTargets.youngest = [];
    if (!details) {
      for (const id of activeSubagents.keys()) {
        const target = { display: String(id), topLevelId: id, restPath: [] };
        latestBroadcastTargets.all.push(target);
        latestBroadcastTargets.youngest.push(target);
      }
      return;
    }
    details.results.forEach((result, index) => {
      collectRunningBroadcastTargetsFromResult(result, [topLevelBaseId + index], latestBroadcastTargets);
    });
    const dedupe = (targets: BroadcastTarget[]) =>
      Array.from(new Map(targets.map((target) => [target.display, target])).values())
        .filter((target) => activeSubagents.has(target.topLevelId))
        .sort((a, b) => a.display.localeCompare(b.display, undefined, { numeric: true }));
    latestBroadcastTargets.all = dedupe(latestBroadcastTargets.all);
    latestBroadcastTargets.youngest = dedupe(latestBroadcastTargets.youngest);
  }

  function getFallbackTopLevelTargets(): BroadcastTarget[] {
    return Array.from(activeSubagents.keys())
      .sort((a, b) => a - b)
      .map((id) => ({ display: String(id), topLevelId: id, restPath: [] }));
  }

  function sendBroadcastToTargets(message: string, targets: BroadcastTarget[], ctx: any): void {
    const delivered: string[] = [];
    const missed: string[] = [];
    for (const target of targets) {
      const item = activeSubagents.get(target.topLevelId);
      if (!item) {
        missed.push(target.display);
        continue;
      }
      item.handle.steer(
        target.restPath.length > 0
          ? encodeNestedBroadcast(message, target.restPath)
          : message,
      );
      delivered.push(target.display);
    }
    if (delivered.length > 0) {
      ctx.ui.notify(`Broadcasted steering message to subagent(s): ${delivered.join(", ")}`, "info");
    }
    if (missed.length > 0) {
      ctx.ui.notify(`Some selected subagents are no longer running: ${missed.join(", ")}`, "warning");
    }
  }

  async function askBroadcastForSteering(message: string, ctx: any): Promise<"continue" | "handled"> {
    const nested = decodeNestedBroadcast(message);
    if (nested) {
      if (activeSubagents.size === 0) return "handled";
      const [rawTarget, ...restPath] = nested.path;
      // Path components below the top level are 1-based task indexes within the
      // subagent tool call running in THIS process. Internal active ids keep
      // growing across sequential tool calls (and process restarts), so resolve
      // by task index first; fall back to a direct id match for compatibility.
      let resolvedId: number | undefined;
      for (const [id, item] of activeSubagents) {
        if (item.taskIndex === rawTarget - 1 && (resolvedId === undefined || id > resolvedId)) {
          resolvedId = id;
        }
      }
      if (resolvedId === undefined && activeSubagents.has(rawTarget)) resolvedId = rawTarget;
      if (resolvedId === undefined) return "handled";
      sendBroadcastToTargets(nested.message, [{ display: nested.path.join("."), topLevelId: resolvedId, restPath }], ctx);
      return "handled";
    }

    if (!ctx.hasUI || activeSubagents.size === 0) return "continue";

    setBroadcastNumberingActive(true);
    try {
      const available = Array.from(activeSubagents.keys()).sort((a, b) => a - b);
      const choice = await ctx.ui.select(
        "Broadcast this steering message to subagents?",
        ["No", "All (+nested)", "Youngest", "Numbers (e.g. 1, 2, 4.1)"],
      );
      if (choice === "All (+nested)" || choice === "Youngest") {
        const fallback = getFallbackTopLevelTargets();
        const selected = choice === "Youngest"
          ? (latestBroadcastTargets.youngest.length > 0 ? latestBroadcastTargets.youngest : fallback)
          : (latestBroadcastTargets.all.length > 0 ? latestBroadcastTargets.all : fallback);
        const current = selected.filter((target) => activeSubagents.has(target.topLevelId));
        if (current.length === 0) {
          ctx.ui.notify("No selected subagents are still running. Continuing with normal steering.", "warning");
          return "continue";
        }
        sendBroadcastToTargets(message, current, ctx);
        return "handled";
      }
      if (choice !== "Numbers (e.g. 1, 2, 4.1)") return "continue";

      const answer = await ctx.ui.input(
        "Subagent numbers/ranges to broadcast to (e.g. 1, 2, 4.1)",
        "",
      );
      if (!answer) return "continue";
      const current = Array.from(new Set([
        ...available,
        ...latestBroadcastTargets.all.map((target) => target.topLevelId),
      ])).sort((a, b) => a - b);
      const parsed = parseBroadcastSelection(answer, current);
      const knownDisplays = new Set(latestBroadcastTargets.all.map((target) => target.display));
      const validatedTargets = knownDisplays.size > 0
        ? parsed.targets.filter((target) => knownDisplays.has(target.display))
        : parsed.targets;
      const unknownNested = knownDisplays.size > 0
        ? parsed.targets.filter((target) => !knownDisplays.has(target.display)).map((target) => target.display)
        : [];
      const errors = [
        ...parsed.errors,
        ...unknownNested.map((display) => `Subagent ${display} is not running.`),
      ];
      if (errors.length > 0) {
        ctx.ui.notify(errors.slice(0, 4).join("\n"), "warning");
      }
      if (validatedTargets.length === 0) {
        ctx.ui.notify("No valid running subagents selected. Continuing with normal steering.", "warning");
        return "continue";
      }
      sendBroadcastToTargets(message, validatedTargets, ctx);
      return "handled";
    } finally {
      setBroadcastNumberingActive(false);
    }
  }

  async function restoreModelAfterResumeFailure(ctx?: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } }) {
    if (!sessionActive) return;
    const restore = modelToRestoreAfterResume;
    modelToRestoreAfterResume = undefined;
    pendingResumePlans = [];
    clearSyntheticResumeState();
    if (!restore) return;
    try {
      await pi.setModel(restore);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx?.ui?.notify?.(`Failed to restore model after subagent resume error: ${message}`, "error");
      console.error("[pi-subagent] Failed to restore model after resume error:", err);
    }
  }

  // Pi exposes footer/status-line extension text through ctx.ui.setStatus().
  // Keep a dedicated line updated with parent + active-branch subagent totals.
  // This is shown by the normal footer underneath Pi's built-in session stats.
  function formatFooterStatusText(ctx: any, text: string): string {
    return typeof ctx?.ui?.theme?.fg === "function"
      ? ctx.ui.theme.fg("dim", text)
      : text;
  }

  function updateCombinedUsageStatus(ctx?: any): void {
    const targetCtx = ctx ?? latestSessionCtx;
    if (!targetCtx?.ui) return;
    try {
      const line = collectCombinedUsageStatusLine(
        targetCtx,
        Array.from(activeSubagentUsageSummaries.values()),
      );
      if (typeof targetCtx.ui.setStatus !== "function") return;
      targetCtx.ui.setStatus(
        "subagent-usage",
        line ? formatFooterStatusText(targetCtx, line) : undefined,
      );
    } catch (err) {
      console.error("[pi-subagent] Failed to update combined subagent status line:", err);
    }
  }

  // Auto-discover agents on session start
  pi.on("session_start", async (event, ctx) => {
    lifecycleGeneration += 1;
    sessionActive = true;
    latestSessionCtx = ctx;
    const includeProjectConfig =
      typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted() === true;
    refreshRegisteredToolPrompts?.(ctx.cwd, includeProjectConfig);
    resumeModelRegistry = ctx.modelRegistry;
    clearSyntheticResumeState();
    pendingResumePlans = [];
    pendingInteractiveResumePrompt = null;
    modelToRestoreAfterResume = undefined;
    updateCombinedUsageStatus(ctx);
    try {
      // Always repair sessions left on the synthetic resume model, even in
      // nested subagents that can no longer delegate. Those leaf processes
      // still need the real model to continue their own work.
      const restorableModel = getRestorableModel(ctx);
      if (restorableModel) {
        lastRestorableModel = restorableModel;
        resumeModelRegistry = ctx.modelRegistry;
      }
      if (ctx.model?.provider === RESUME_PROVIDER && restorableModel) {
        await pi.setModel(restorableModel);
      }

      if (!canDelegate) return;

      const discovery = discoverAgents(ctx.cwd, "both");
      discoveredAgents = filterAgentsForCurrentLayer(discovery.agents, currentDepth, maxDepth);
      currentSessionId = ctx.sessionManager.getSessionId?.() ?? "ephemeral";
      currentSubagentSessionRoot = getDefaultSubagentSessionRoot(ctx);
      if (resumableSubagentsDisabled()) {
        currentNamesFile = "";
        currentOwnerId = currentSessionId;
      } else {
        try {
          // Pi assigns resumed/branched sessions a NEW session id, so the
          // registry path and ownership key must NOT be derived from the live
          // session id alone. Resolution order:
          //   1. identity persisted in the session metadata (custom entry) —
          //      the session's own record always wins
          //   2. env (a child subagent process's FIRST run, before it has
          //      persisted anything)
          //   3. ancestor walk over header.parentSession (self-heals sessions
          //      from before the identity entry existed)
          //   4. fresh path from the current session id
          const inherited = getInheritedNamesFile();
          const persisted = findPersistedNamesIdentity(ctx.sessionManager.getEntries?.() ?? []);
          if (persisted) {
            currentNamesFile = persisted.namesFile;
            currentOwnerId = persisted.ownerId;
          } else if (inherited) {
            currentNamesFile = inherited;
            currentOwnerId = currentSessionId;
          } else {
            const ancestor = findAncestorNamesFile(
              currentSubagentSessionRoot,
              currentSessionId,
              (ctx.sessionManager as any).getHeader?.(),
            );
            currentNamesFile = ancestor?.namesFile ?? getNamesFilePath(currentSubagentSessionRoot, currentSessionId);
            currentOwnerId = ancestor?.ownerId ?? currentSessionId;
          }
          // NOTE: the registry path is passed to child processes via their
          // spawn env in the runner. It must NOT be set on process.env here:
          // pi reloads extension modules on session switches, and a self-set
          // env var would then masquerade as "inherited from a parent",
          // overriding the identity persisted in the session being resumed.
          // Persist the identity into the session so the next resume/branch of
          // this session (with whatever new session id pi assigns) finds it.
          if (
            (!persisted || persisted.namesFile !== currentNamesFile || persisted.ownerId !== currentOwnerId) &&
            typeof (pi as any).appendEntry === "function"
          ) {
            (pi as any).appendEntry(SUBAGENT_NAMES_CUSTOM_TYPE, {
              namesFile: currentNamesFile,
              ownerId: currentOwnerId,
            });
          }
        } catch (err) {
          console.error("[pi-subagent] Failed to initialize subagent name registry:", err);
          currentNamesFile = "";
          currentOwnerId = currentSessionId;
        }
      }

      if (discoveredAgents.length > 0 && ctx.hasUI) {
        const list = discoveredAgents
          .map((a) => `  - ${a.name} (${a.source})`)
          .join("\n");
        ctx.ui.notify(
          `Found ${discoveredAgents.length} subagent(s):\n${list}`,
          "info",
        );
      }

      const resumeDisabled = parseBooleanEnv(process.env[SUBAGENT_RESUME_DISABLE_ENV]) === true;
      if (resumeDisabled || (event.reason !== "resume" && event.reason !== "startup")) return;

      await maybeOfferSubagentResume(ctx, { deferInteractivePrompt: true });
    } catch (err) {
      console.error("[pi-subagent] Error in session_start:", err);
      await restoreModelAfterResumeFailure(ctx);
    }
  });

  // Pi 0.81 replaces and rebinds the entire extension runtime on /resume,
  // /new, /fork, and /reload. Invalidate every detached callback so it cannot
  // use stale pi/context objects after the old runtime has been torn down.
  pi.on("session_shutdown", () => {
    sessionActive = false;
    lifecycleGeneration += 1;
    for (const timer of scheduledTasks) clearTimeout(timer);
    scheduledTasks.clear();
    clearSyntheticResumeState();
    pendingResumePlans = [];
    pendingInteractiveResumePrompt = null;
    modelToRestoreAfterResume = undefined;
    latestSessionCtx = undefined;
    resumeModelRegistry = undefined;
    activeSubagentUsageSummaries.clear();
    activeSubagents.clear();
  });

  /**
   * Detect unfinished subagent calls at the current branch leaf and offer to
   * resume them. Shared between session_start (startup/resume) and
   * session_tree (TUI tree navigation back to a subagent point).
   *
   * When deferInteractivePrompt is true, the interactive resume prompt is
   * queued for resources_discover (only valid during session_start, before the
   * initial chat render). Otherwise the prompt is sent directly after a short
   * delay.
   */
  async function maybeOfferSubagentResume(
    ctx: any,
    opts: { deferInteractivePrompt: boolean },
  ): Promise<void> {
    const restorableModel = getRestorableModel(ctx);
    if (restorableModel) {
      lastRestorableModel = restorableModel;
      resumeModelRegistry = ctx.modelRegistry;
    }

    const plans = findLatestResumableSubagentCalls(ctx);
    if (plans.length === 0) return;
    const totalTaskCount = plans.reduce((sum, plan) => sum + plan.tasks.length, 0);

    let shouldResume = true;
    const shouldPrompt = parseBooleanEnv(process.env[SUBAGENT_RESUME_PROMPT_ENV]) !== false;
    const rpcMode = isRpcMode(process.argv);
    if (ctx.hasUI && !rpcMode && shouldPrompt) {
      shouldResume = await ctx.ui.confirm(
        "Resume subagents?",
        `The resumed session has ${plans.length === 1 ? "an" : String(plans.length)} unfinished subagent call${plans.length === 1 ? "" : "s"} (${totalTaskCount} task${totalTaskCount === 1 ? "" : "s"}). Resume from saved subagent sessions?`,
      );
    }
    if (!shouldResume) {
      if (ctx.model?.provider === RESUME_PROVIDER) {
        if (restorableModel) {
          await pi.setModel(restorableModel);
        } else {
          ctx.ui.notify(
            `Subagent resume was declined, but the current model is the synthetic resume model and no real fallback model is available. Select a real model before continuing, or set ${SUBAGENT_FALLBACK_MODEL_ENV}=provider/model.`,
            "error",
          );
        }
      }
      return;
    }

    if (!restorableModel && ctx.model?.provider === RESUME_PROVIDER) {
      ctx.ui.notify(
        `Cannot resume subagents while on the synthetic resume model because no real fallback model is available. Select a real model or set ${SUBAGENT_FALLBACK_MODEL_ENV}=provider/model.`,
        "error",
      );
      return;
    }

    pendingResumePlans = [...plans];
    resumeState.plans = [...plans];
    resumeState.phase = "tool";
    // Headless subprocess/RPC subagents cannot answer a visible resume
    // prompt. They already receive an initial RPC prompt from the parent
    // runner, so inject the synthetic resume tool call into that next model
    // request. Interactive top-level sessions keep using a visible prompt so
    // the user sees exactly what is happening.
    const injectOnNextRequest = rpcMode || hasCliInitialPrompt(process.argv) || !ctx.hasUI;
    resumeState.trigger = injectOnNextRequest ? "nextRequest" : "resumePrompt";
    modelToRestoreAfterResume = restorableModel ?? ctx.model;
    resumeModelRegistry = ctx.modelRegistry;
    ensureSubagentToolActive(pi);
    const resumeModel = ctx.modelRegistry.find(RESUME_PROVIDER, RESUME_MODEL_ID);
    if (!resumeModel || !(await pi.setModel(resumeModel))) {
      ctx.ui.notify("Failed to switch to synthetic subagent resume model.", "error");
      await restoreModelAfterResumeFailure(ctx);
      return;
    }

    // In print/json subprocesses there is already an initial CLI prompt about
    // to be sent. That prompt will be answered by the synthetic provider with
    // a real assistant subagent tool call. In interactive mode, submit a short
    // visible prompt that triggers the same synthetic provider path.
    if (injectOnNextRequest) {
      if (ctx.hasUI) ctx.ui.notify(`Resuming ${totalTaskCount} subagents...`, "info");
    } else if (opts.deferInteractivePrompt) {
      // Do not start the synthetic resume turn from session_start. Pi renders
      // the resumed chat only after session_start/resources_discover complete;
      // starting now lets that render wipe out the live tool component, so no
      // real-time updates appear. Queue it for resources_discover instead,
      // which is the last extension hook before the initial chat render.
      pendingInteractiveResumePrompt = `Resuming ${totalTaskCount} subagents...`;
    } else {
      scheduleSessionTask(() => {
        try {
          pi.sendUserMessage(`Resuming ${totalTaskCount} subagents...`);
        } catch (err) {
          console.error("[pi-subagent] Failed to start resume turn after tree navigation:", err);
          void restoreModelAfterResumeFailure(ctx);
        }
      }, RESUME_INTERACTIVE_DELAY_MS);
    }
  }

  // Offer to resume subagents after the user navigates the session tree (Esc
  // navigation in the TUI) back to a point with an unfinished subagent call.
  pi.on("session_tree", async (event: any, ctx) => {
    latestSessionCtx = ctx;
    updateCombinedUsageStatus(ctx);
    try {
      if (!canDelegate) return;
      // Skip extension-driven navigation (e.g. compaction) and any state where
      // a resume is already pending or subagents are still running.
      if (event?.fromExtension) return;
      if (activeSubagents.size > 0) return;
      if (pendingResumePlans.length > 0) return;
      if (pendingInteractiveResumePrompt) return;
      if (ctx.model?.provider === RESUME_PROVIDER) return;
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;

      const resumeDisabled = parseBooleanEnv(process.env[SUBAGENT_RESUME_DISABLE_ENV]) === true;
      if (resumeDisabled) return;

      await maybeOfferSubagentResume(ctx, { deferInteractivePrompt: false });
    } catch (err) {
      console.error("[pi-subagent] Error in session_tree:", err);
      await restoreModelAfterResumeFailure(ctx);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    updateCombinedUsageStatus(ctx);
    await restoreModelAfterResumeFailure();
  });

  pi.on("message_end", (_event, ctx) => {
    latestSessionCtx = ctx;
    updateCombinedUsageStatus(ctx);
    scheduleSessionTask(() => updateCombinedUsageStatus(ctx), 0);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    latestSessionCtx = ctx;
    if (isSubagentToolName(event.toolName)) {
      activeSubagentUsageSummaries.delete(event.toolCallId);
      updateCombinedUsageStatus(ctx);
      scheduleSessionTask(() => updateCombinedUsageStatus(ctx), 0);
    }
  });

  pi.on("resources_discover", (_event, ctx) => {
    const prompt = pendingInteractiveResumePrompt;
    if (!prompt) return;
    pendingInteractiveResumePrompt = null;
    scheduleSessionTask(() => {
      try {
        pi.sendUserMessage(prompt);
      } catch (err) {
        console.error("[pi-subagent] Failed to start deferred resume turn:", err);
        void restoreModelAfterResumeFailure(ctx);
      }
    }, RESUME_INTERACTIVE_DELAY_MS);
  });

  pi.on("input", async (event, ctx) => {
    try {
      // Encoded nested-broadcast envelopes must never leak into this agent's
      // conversation as literal text. Intercept them unconditionally: if the
      // target subagent is gone, the message is dropped (best effort).
      if (decodeNestedBroadcast(event.text)) {
        await askBroadcastForSteering(event.text, ctx);
        return { action: "handled" as const };
      }
      // Pi emits this before it applies the built-in streaming behavior. When a
      // subagent tool is running, only mid-stream steering messages should be
      // candidates for child broadcast. Idle prompts and queued follow-ups must
      // continue normally so they reach the parent conversation as intended.
      if (activeSubagents.size === 0) return { action: "continue" as const };
      if (!isStreamingSteerInput(event, ctx)) return { action: "continue" as const };
      const result = await askBroadcastForSteering(event.text, ctx);
      return result === "handled"
        ? { action: "handled" as const }
        : { action: "continue" as const };
    } catch (err) {
      console.error("[pi-subagent] Error while handling steering broadcast:", err);
      return { action: "continue" as const };
    }
  });

  // Inject available agents into the system prompt
  pi.on("before_agent_start", async (event) => {
    try {
      if (!canDelegate) return;
      if (discoveredAgents.length === 0) return;

      const agentList = discoveredAgents
        .map((a) => `- **${a.name}**: ${a.description}`)
        .join("\n");
      const subagentsGuidance = configuredToolPrompts[SUBAGENT_TOOL_NAME] ?? `### How to call the subagents tool

Each subagent runs in an **isolated process**.

Pass a \`tasks\` array. **Every task in the same call runs in parallel.**
- 1 task  -> single delegation
- N tasks -> all N run concurrently in one call

For **sequential** work (task B needs task A's output), make separate tool
calls one after another. Do NOT put dependent tasks in the same array.

**Single (1 agent)**:
\`\`\`json
{ "tasks": [{ "agent": "agent-name", "task": "Detailed task..." }] }
\`\`\`

**Parallel (N agents at once)**:
\`\`\`json
{ "tasks": [{ "agent": "agent-a", "task": "..." }, { "agent": "agent-b", "task": "..." }] }
\`\`\`

- Max depth: current depth ${currentDepth}, max depth ${maxDepth}
- Max subagents per tool call: ${maxParallelTasks}`;
      const resumeGuidance = resumableSubagentsDisabled()
        ? ""
        : configuredToolPrompts[RESUME_SUBAGENTS_TOOL_NAME] ?? `### Resumable subagents

Every subagent run is assigned a unique, durable name (e.g. \`code-writer-01\`,
\`code-reviewer-02\`) which is returned together with its results. Use the
\`resume_subagents\` tool to continue named subagents with a new task while
keeping their full previous context:

\`\`\`json
{ "resumes": [{ "subagent": "code-writer-01", "task": "Now also update the tests." }] }
\`\`\`

- \`agent\` (in \`subagents\`) is an agent TYPE; \`subagent\` (in \`resume_subagents\`)
  is the unique name of an already-run subagent instance.
- All resumes in one call run in parallel.
- You may include subagent names in the task text you give YOUR OWN subagents,
  so they can resume those subagents themselves.
- Names survive restarts; you can resume them in a later session of this conversation.`;
      return {
        systemPrompt: `${event.systemPrompt}\n\n## Available Subagents

The following subagents are available via the \`subagents\` tool:

${agentList}\n\n${subagentsGuidance}${resumeGuidance ? `\n\n${resumeGuidance}` : ""}`,
      };
    } catch (err) {
      console.error("[pi-subagent] Error in before_agent_start:", err);
    }
  });

  // Register the subagents tool
  if (canDelegate) {
    const registerSubagentsTool = () => {
      pi.registerTool({
      name: SUBAGENT_TOOL_NAME,
      label: "Subagents",
      description: configuredToolPrompts[SUBAGENT_TOOL_NAME] ?? getSubagentsToolDescription(),
      parameters: SubagentParams,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        try {
          recordToolCallStart(toolCallId);
          updateLatestBroadcastTargets(undefined);
          const discovery = discoverAgents(ctx.cwd, "both");
          const agents = filterAgentsForCurrentLayer(discovery.agents, currentDepth, maxDepth);

          const makeDetails = makeDetailsFactory(
            discovery.projectAgentsDir,
            DEFAULT_DELEGATION_MODE,
          );

          const tasks = params.tasks ?? [];
          if (tasks.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Invalid parameters. Provide a non-empty tasks array.\nAvailable agents: ${formatAgentNames(agents)}`,
                },
              ],
              details: makeDetails("single")([]),
            };
          }

          const executionMode = tasks.length === 1 ? "single" : "parallel";
          const topLevelBaseId = nextActiveSubagentId;
          nextActiveSubagentId += tasks.length;
          const trackedOnUpdate = (partial: any) => {
            if (isSubagentDetails(partial?.details)) {
              activeSubagentUsageSummaries.set(toolCallId, collectLiveUsageSummary(partial.details));
              updateLatestBroadcastTargets(partial.details, topLevelBaseId);
              updateCombinedUsageStatus(ctx);
              emitNestedProgressToParent(toolCallId, partial.details);
            }
            onUpdate?.(partial);
          };

          // Security: guard project-local agents before running
          const requested = new Set<string>();
          for (const t of tasks) requested.add(t.agent);

          if (preventCycles) {
            const cycleViolations = getCycleViolations(
              requested,
              ancestorAgentStack,
            );
            if (cycleViolations.length > 0) {
              const stackText =
                ancestorAgentStack.length > 0
                  ? ancestorAgentStack.join(" -> ")
                  : "(root)";
              return {
                content: [
                  {
                    type: "text",
                    text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
                  },
                ],
                details: makeDetails(executionMode)([]),
                isError: true,
              };
            }
          }

          const requestedProjectAgents = getRequestedProjectAgents(
            agents,
            requested,
          );
          const projectAgentConfirmationSetting =
            getProjectAgentConfirmationSetting();
          const projectAgentSessionKey = getProjectAgentSessionKey(
            discovery.projectAgentsDir,
          );
          const shouldConfirmProjectAgents =
            requestedProjectAgents.length > 0 &&
            projectAgentConfirmationSetting === "ask" &&
            !approvedProjectAgentDirsForSession.has(projectAgentSessionKey);
          if (shouldConfirmProjectAgents) {
            if (ctx.hasUI && !isRpcMode(process.argv)) {
              const approval = await confirmProjectAgentsIfNeeded(
                requestedProjectAgents,
                discovery.projectAgentsDir,
                ctx,
              );
              if (approval === "no") {
                return {
                  content: [
                    {
                      type: "text",
                      text: "Canceled: project-local agents not approved.",
                    },
                  ],
                  details: makeDetails(executionMode)([]),
                };
              }
              if (approval === "session") {
                approvedProjectAgentDirsForSession.add(projectAgentSessionKey);
              }
            } else {
              const names = requestedProjectAgents.map((a) => a.name).join(", ");
              const dir = discovery.projectAgentsDir ?? "(unknown)";
              return {
                content: [
                  {
                    type: "text",
                    text: `Blocked: project-local agent confirmation is required in non-UI mode.\nAgents: ${names}\nSource: ${dir}\n\nSet ${SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV}=false or =session only if this repository is trusted.`,
                  },
                ],
                details: makeDetails(executionMode)([]),
                isError: true,
              };
            }
          }

          const resumePlanIndex = pendingResumePlans.findIndex((plan) => sameTasks(plan.tasks, tasks));
          const resumePlan = resumePlanIndex >= 0 ? pendingResumePlans[resumePlanIndex] : null;
          if (resumePlanIndex >= 0) {
            pendingResumePlans.splice(resumePlanIndex, 1);
          }

          // Assign durable, tree-unique names (code-writer-01, ...). Resumed
          // runs keep the names already recorded in the previous results.
          const names: Array<string | undefined> = tasks.map(
            (_task, index) => resumePlan?.details?.results[index]?.name,
          );
          if (currentNamesFile) {
            const pendingAllocation = tasks
              .map((task, index) => ({ task, index }))
              .filter(({ index }) => !names[index]);
            if (pendingAllocation.length > 0) {
              try {
                const allocated = await allocateSubagentNames(
                  currentNamesFile,
                  currentOwnerId,
                  pendingAllocation.map(({ task, index }) => {
                    const agentConfig = agents.find((agent) => agent.name === task.agent);
                    return {
                      agent: task.agent,
                      task: task.task,
                      model:
                        formatModelFlag(getParentModelForSubagent(ctx)) ?? agentConfig?.model,
                      tools: agentConfig?.tools,
                      sessionDir:
                        resumePlan?.details?.results[index]?.sessionDir ??
                        getSessionDirForTask(resumePlan?.previousToolCallId ?? toolCallId, index),
                    };
                  }),
                );
                pendingAllocation.forEach(({ index }, allocIndex) => {
                  names[index] = allocated[allocIndex];
                });
              } catch (err) {
                console.warn("[pi-subagent] Failed to allocate subagent names (continuing without):", err);
              }
            }
          }

          if (tasks.length === 1) {
            const [task] = tasks;
            return executeSingle(
              task.agent,
              task.task,
              agents,
              ctx.cwd,
              signal,
              trackedOnUpdate,
              makeDetails,
              resumePlan?.details?.results[0],
              getSessionDirForTask(resumePlan?.previousToolCallId ?? toolCallId, 0),
              !!resumePlan,
              // Normal calls inherit the model that emitted this tool call;
              // synthetic resume calls recover the preceding real model.
              formatModelFlag(getParentModelForSubagent(ctx)),
              topLevelBaseId,
              names[0],
            );
          }

          return await executeParallel(
            tasks,
            agents,
            ctx.cwd,
            signal,
            trackedOnUpdate,
            makeDetails,
            resumePlan?.details?.results,
            (index) => getSessionDirForTask(resumePlan?.previousToolCallId ?? toolCallId, index),
            !!resumePlan,
            formatModelFlag(getParentModelForSubagent(ctx)),
            topLevelBaseId,
            { names },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
          return {
            content: [{ type: "text" as const, text: `[pi-subagent] Unexpected error: ${msg}${stack}` }],
            details: buildSubagentDetails("single", DEFAULT_DELEGATION_MODE, null, []),
            isError: true,
          };
        }

      },

      renderCall: (args, theme, context) => renderCall(args, theme, context),
      renderResult: (result, { expanded }, theme) =>
        renderResult(result, expanded, theme),
      });
    };

    const registerResumeSubagentsTool = () => {
      if (resumableSubagentsDisabled()) return;
      pi.registerTool({
      name: RESUME_SUBAGENTS_TOOL_NAME,
      label: "Resume subagents",
      description: configuredToolPrompts[RESUME_SUBAGENTS_TOOL_NAME] ?? [
        "Resume previously run subagents by name with a new task, keeping their full context.",
        "",
        "Every subagent run returns a unique name (e.g. code-writer-01). Pass those names",
        "as `subagent` to continue them. All resumes in one call run IN PARALLEL.",
        "",
        'Example: { resumes: [{ subagent: "code-writer-01", task: "Also update the tests." }] }',
      ].join("\n"),
      parameters: ResumeSubagentsParams,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const markedNames: string[] = [];
        try {
          recordToolCallStart(toolCallId);
          updateLatestBroadcastTargets(undefined);
          const discovery = discoverAgents(ctx.cwd, "both");
          const makeDetails = makeDetailsFactory(
            discovery.projectAgentsDir,
            DEFAULT_DELEGATION_MODE,
          );
          const fail = (text: string) => ({
            content: [{ type: "text" as const, text }],
            details: makeDetails("parallel")([]),
            isError: true,
          });

          const resumes = normalizeResumes((params as any).resumes);
          if (resumes.length === 0) {
            return fail("Invalid parameters. Provide a non-empty resumes array of {subagent, task} objects (both fields are required strings).");
          }

          const duplicates = resumes
            .map((resume) => resume.name)
            .filter((name, index, all) => all.indexOf(name) !== index);
          if (duplicates.length > 0) {
            return fail(`Duplicate subagent names in one resume call: ${Array.from(new Set(duplicates)).join(", ")}. Resume each name at most once per call.`);
          }

          if (!currentNamesFile) {
            return fail("No subagent name registry is available in this session (sessions may be disabled). Subagents cannot be resumed by name here.");
          }

          // Refuse to resume subagents that are still running or being resumed
          // in this process: continuing a session file while another process is
          // writing it corrupts it. (Cross-process protection comes from the
          // registry markers below.)
          const runningNames = new Set(
            Array.from(activeSubagents.values())
              .map((item) => item.name)
              .filter((name): name is string => typeof name === "string"),
          );
          for (const name of activeResumeNames) runningNames.add(name);
          const stillRunning = resumes.filter((resume) => runningNames.has(resume.name));
          if (stillRunning.length > 0) {
            return fail(`Cannot resume subagents that are still running: ${stillRunning.map((r) => r.name).join(", ")}. Wait for them to finish first.`);
          }
          for (const resume of resumes) activeResumeNames.add(resume.name);
          const localGuardedNames = resumes.map((resume) => resume.name);
          const releaseLocalGuards = () => {
            for (const name of localGuardedNames) activeResumeNames.delete(name);
          };

          try {
            // Resolve every name to a target session dir (own session or private fork).
            const errors: string[] = [];
            const targets: Array<{
              agent: string;
              task: string;
              sessionDir: string;
              name: string;
              model?: string;
              tools?: string[];
            }> = [];
            const hasSessionFiles = (dir: string): boolean => {
              try {
                return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith(".jsonl"));
              } catch {
                return false;
              }
            };
            for (const resume of resumes) {
              const resolution = await resolveResumeTarget(currentNamesFile, resume.name, currentOwnerId);
              if ("error" in resolution) {
                errors.push(resolution.error);
                continue;
              }
              if (resolution.isFork) {
                if (!hasSessionFiles(resolution.sessionDir)) {
                  if (!forkSessionInto(resolution.record.sessionDir, resolution.sessionDir)) {
                    errors.push(`Cannot fork subagent "${resume.name}": no session files found in ${resolution.record.sessionDir}.`);
                    continue;
                  }
                }
                if (resolution.forkCreated) {
                  await commitFork(currentNamesFile, resume.name, currentOwnerId, resolution.sessionDir);
                }
              } else if (!hasSessionFiles(resolution.sessionDir)) {
                errors.push(`Cannot resume subagent "${resume.name}": its session directory ${resolution.sessionDir} has no saved session files (the original run may have failed before doing anything).`);
                continue;
              }
              targets.push({
                agent: resolution.record.agent,
                task: resume.task,
                sessionDir: resolution.sessionDir,
                name: resume.name,
                model: resolution.record.model,
                tools: resolution.record.tools,
              });
            }
            if (errors.length > 0) {
              releaseLocalGuards();
              const known = Object.keys(readNamesRegistry(currentNamesFile).agents).sort();
              return fail(`${errors.join("\n")}\n\nKnown subagent names: ${known.length > 0 ? known.join(", ") : "(none)"}.`);
            }

            // Cross-process in-flight markers: another live pi process resuming
            // the same target must not race us into the same session file.
            const markerErrors: string[] = [];
            for (const target of targets) {
              const marked = await markResumeActive(currentNamesFile, target.name, currentOwnerId);
              if ("error" in marked) {
                markerErrors.push(marked.error);
              } else {
                markedNames.push(target.name);
              }
            }
            if (markerErrors.length > 0) {
              releaseLocalGuards();
              return fail(markerErrors.join("\n"));
            }

            for (const target of targets) {
              await updateNameRecord(currentNamesFile, target.name, { lastResumePrompt: target.task });
            }

            // Resumed agents may reference agent types whose definition files no
            // longer exist; the session itself carries all needed context, so
            // synthesize a config from the registry record instead of failing.
            const agentsForResume: AgentConfig[] = [...discovery.agents];
            for (const target of targets) {
              if (!agentsForResume.some((agent) => agent.name === target.agent)) {
                agentsForResume.push({
                  name: target.agent,
                  description: "(resumed subagent; original agent definition not found)",
                  systemPrompt: "",
                  model: target.model,
                  tools: target.tools,
                  source: "builtin",
                  filePath: "",
                });
              }
            }

            const tasks = targets.map((target) => ({ agent: target.agent, task: target.task }));
            const topLevelBaseId = nextActiveSubagentId;
            nextActiveSubagentId += tasks.length;
            const trackedOnUpdate = (partial: any) => {
              if (isSubagentDetails(partial?.details)) {
                activeSubagentUsageSummaries.set(toolCallId, collectLiveUsageSummary(partial.details));
                updateLatestBroadcastTargets(partial.details, topLevelBaseId);
                updateCombinedUsageStatus(ctx);
                emitNestedProgressToParent(toolCallId, partial.details);
              }
              onUpdate?.(partial);
            };

            return await executeParallel(
              tasks,
              agentsForResume,
              ctx.cwd,
              signal,
              trackedOnUpdate,
              makeDetails,
              undefined,
              (index) => targets[index].sessionDir,
              true,
              formatModelFlag(getParentModelForSubagent(ctx)),
              topLevelBaseId,
              { names: targets.map((target) => target.name), rawPrompts: true },
            );
          } finally {
            releaseLocalGuards();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
          return {
            content: [{ type: "text" as const, text: `[pi-subagent] Unexpected error: ${msg}${stack}` }],
            details: buildSubagentDetails("parallel", DEFAULT_DELEGATION_MODE, null, []),
            isError: true,
          };
        } finally {
          if (currentNamesFile) {
            for (const name of markedNames) {
              await clearResumeActive(currentNamesFile, name, currentOwnerId);
            }
          }
        }
      },

      renderCall: (args, theme, context) => renderResumeCall(args, theme, context),
      renderResult: (result, { expanded }, theme) =>
        renderResult(result, expanded, theme),
      });
    };

    const registerToolsWithConfig = (
      cwd?: string,
      includeProject = false,
      force = false,
    ) => {
      const nextToolPrompts = loadPiSubagentsConfig(cwd, includeProject).toolPrompts;
      if (!force && sameToolPrompts(configuredToolPrompts, nextToolPrompts)) return;
      configuredToolPrompts = nextToolPrompts;
      registerSubagentsTool();
      registerResumeSubagentsTool();
    };
    refreshRegisteredToolPrompts = (cwd, includeProject) => {
      registerToolsWithConfig(cwd, includeProject);
    };
    registerToolsWithConfig(undefined, false, true);
  }

  function getSessionDirForTask(toolCallId: string, index: number): string {
    if (!currentSubagentSessionRoot) {
      throw new Error("Cannot create subagent session dir: subagent session root is not initialized.");
    }
    return buildSubagentSessionDir(currentSubagentSessionRoot, currentSessionId, toolCallId, index);
  }

  // -----------------------------------------------------------------------
  // Mode implementations
  // -----------------------------------------------------------------------

  function formatNameSuffix(result: SingleResult | undefined): string {
    return result?.name ? `\n\n(subagent name: ${result.name} — resumable via resume_subagents)` : "";
  }

  async function executeSingle(
    agentName: string,
    task: string,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
    previousResult: SingleResult | undefined,
    sessionDir: string,
    resumeExistingSession: boolean,
    fallbackModel: string | undefined,
    topLevelBaseId: number,
    subagentName?: string,
  ) {
    if (previousResult && isFinishedResult(previousResult)) {
      return {
        content: [
          {
            type: "text" as const,
            text: (getFinalOutput(previousResult.messages) || "(no output)") + formatNameSuffix(previousResult),
          },
        ],
        details: makeDetails("single")([previousResult]),
      };
    }

    let activeId: number | undefined;
    const result = await runAgentSubprocess({
      cwd: defaultCwd,
      agents,
      agentName,
      task,
      subagentName,
      parentDepth: currentDepth,
      parentAgentStack: ancestorAgentStack,
      maxDepth,
      preventCycles,
      signal,
      onUpdate,
      makeDetails: makeDetails("single"),
      sessionDir: previousResult?.sessionDir ?? sessionDir,
      sessionRoot: currentSubagentSessionRoot,
      namesFile: currentNamesFile || undefined,
      resumeSession: resumeExistingSession,
      initialResult: previousResult,
      fallbackModel,
      onHandle: (handle) => {
        activeId = topLevelBaseId;
        activeSubagents.set(activeId, { agent: agentName, task, taskIndex: 0, handle, name: subagentName });
        updateLatestBroadcastTargets(undefined);
      },
    });
    if (activeId !== undefined) {
      activeSubagents.delete(activeId);
      updateLatestBroadcastTargets(undefined);
    }

    if (isResultError(result)) {
      const errorMsg =
        result.errorMessage ||
        result.stderr ||
        getFinalOutput(result.messages, result.finalOutput) ||
        "(no output)";
      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${result.stopReason || "failed"}: ${errorMsg}`,
          },
        ],
        details: makeDetails("single")([result]),
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: (getFinalOutput(result.messages, result.finalOutput) || "(no output)") + formatNameSuffix(result),
        },
      ],
      details: makeDetails("single")([result]),
    };
  }

  async function executeParallel(
    tasks: Array<{ agent: string; task: string }>,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
    resumeResults: SingleResult[] | undefined,
    getSessionDir: (index: number) => string,
    resumeExistingSessions: boolean,
    fallbackModel: string | undefined,
    topLevelBaseId: number,
    extras?: { names?: Array<string | undefined>; rawPrompts?: boolean },
  ) {
    const taskIds = new Map<number, number>();
    try {
      return await executeParallelSubprocess(
        tasks,
        agents,
        defaultCwd,
        currentDepth,
        maxDepth,
        ancestorAgentStack,
        preventCycles,
        signal,
        onUpdate,
        makeDetails("parallel"),
        resumeResults,
        (index) => getSessionDir(index),
        resumeExistingSessions,
        currentSubagentSessionRoot,
        fallbackModel,
        (index, task, handle) => {
          const id = topLevelBaseId + index;
          taskIds.set(index, id);
          activeSubagents.set(id, { agent: task.agent, task: task.task, taskIndex: index, handle, name: extras?.names?.[index] });
          updateLatestBroadcastTargets(undefined);
        },
        (index) => {
          const id = taskIds.get(index);
          if (id !== undefined) {
            activeSubagents.delete(id);
            updateLatestBroadcastTargets(undefined);
          }
        },
        { ...extras, namesFile: currentNamesFile || undefined },
      );
    } finally {
      for (const id of taskIds.values()) activeSubagents.delete(id);
    }
  }
}
