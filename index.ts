/**
 * Pi Subagent Extension
 *
 * Delegates tasks to specialized subagents running as isolated `pi` processes.
 *
 * The tool always accepts a `tasks` array:
 *   - One task: treated as a single-agent delegation.
 *   - Multiple tasks: treated as a parallel delegation.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  streamSimple as streamModelSimple,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverAgents } from "./agents.js";
import { renderCall, renderResult } from "./render.js";
import { runAgentSubprocess, executeParallelSubprocess } from "./runner.js";
import {
  SUBAGENT_RESUME_DISABLE_ENV,
  SUBAGENT_RESUME_PROMPT_ENV,
  branchEntries,
  buildSubagentSessionDir,
  findLatestResumableSubagentCall,
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
  DEFAULT_DELEGATION_MODE,
  buildSubagentDetails,
  getFinalOutput,
  isResultError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = false;
const DEFAULT_PROJECT_AGENT_CONFIRMATION = "ask";
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_CONFIRM_PROJECT_AGENTS_ENV = "PI_SUBAGENT_CONFIRM_PROJECT_AGENTS";

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
  cwd: Type.Optional(
    Type.String({ description: "Working directory for this agent's process" }),
  ),
});

const SubagentParams = Type.Object({
  tasks: Type.Array(TaskItem, {
    minItems: 1,
    description:
      "Array of {agent, task} objects. One task behaves like a single-agent delegation; multiple tasks run concurrently.",
  }),
});

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
  return (mode: "single" | "parallel") =>
    (results: SingleResult[]): SubagentDetails =>
      buildSubagentDetails(mode, delegationMode, projectAgentsDir, results);
}

function formatAgentNames(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
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
  if (!activeTools.includes("subagent")) {
    pi.setActiveTools([...activeTools, "subagent"]);
  }
}

function hasCliInitialPrompt(argv: string[]): boolean {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--print") return true;
  }
  return false;
}

const RESUME_STATE_KEY = "__piSubagentResumeState";
const SUBAGENT_FALLBACK_MODEL_ENV = "PI_SUBAGENT_FALLBACK_MODEL";
const RESUME_INTERACTIVE_DELAY_MS = 50;

type SyntheticResumeState = {
  plan: ResumableSubagentCall | null;
  phase: "tool" | "final";
  trigger: "resumePrompt" | "nextRequest";
};

function clearSyntheticResumeState(): void {
  const state = getSyntheticResumeState();
  state.plan = null;
  state.phase = "tool";
  state.trigger = "resumePrompt";
}

function getSyntheticResumeState(): SyntheticResumeState {
  const g = globalThis as any;
  if (!g[RESUME_STATE_KEY]) {
    g[RESUME_STATE_KEY] = { plan: null, phase: "tool", trigger: "resumePrompt" } satisfies SyntheticResumeState;
  }
  return g[RESUME_STATE_KEY] as SyntheticResumeState;
}

function emptyModelUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

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

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let resumeModelRegistry: any | undefined;
  let lastRestorableModel: any | undefined;
  let pendingInteractiveResumePrompt: string | null = null;

  async function streamWithRealModelFallback(context: any, options: any, fallback: any) {
    if (!fallback) return null;
    const auth = resumeModelRegistry
      ? await resumeModelRegistry.getApiKeyAndHeaders(fallback)
      : { ok: true, apiKey: undefined, headers: undefined };
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    return streamModelSimple(fallback, context, {
      ...options,
      apiKey: auth.apiKey,
      headers: auth.headers,
    });
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

  pi.registerProvider(RESUME_PROVIDER, {
    baseUrl: "http://127.0.0.1/pi-subagent-resume",
    api: "openai-responses",
    apiKey: "pi-subagent-resume-noop-key",
    streamSimple: async (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const state = getSyntheticResumeState();
      const plan = state.plan;
      const phase = state.phase;
      const triggerMatches =
        state.trigger === "nextRequest" ||
        (plan ? isSyntheticResumePrompt(context, plan.tasks.length) : false);
      if (plan && phase === "tool" && triggerMatches) {
        state.phase = "final";
        const toolCall = {
          type: "toolCall" as const,
          id: `resume_subagent_${Date.now()}`,
          name: "subagent",
          arguments: { tasks: plan.tasks },
        };
        const message = {
          role: "assistant" as const,
          content: [toolCall],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyModelUsage(),
          stopReason: "toolUse" as const,
          timestamp: Date.now(),
        };
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end(message);
        });
        return stream;
      }

      if (phase === "final" && modelToRestoreAfterResume) {
        const delegated = await streamWithRealModelFallback(context, options, modelToRestoreAfterResume);
        if (delegated) return delegated;
      }

      const fallback = await streamWithRealModelFallback(context, options, lastRestorableModel);
      if (fallback) return fallback;

      if (!(plan && phase === "tool")) {
        state.plan = null;
        state.phase = "tool";
      }
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "Subagent resume failed: synthetic resume provider was invoked without a valid resume plan." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyModelUsage(),
        stopReason: "error" as const,
        errorMessage: "Subagent resume failed: synthetic resume provider was invoked without a valid resume plan.",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      });
      return stream;
    },
    models: [
      {
        id: RESUME_MODEL_ID,
        name: "Pi Subagent Resume",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Keep this large so Pi's pre-prompt auto-compaction does not call the
        // synthetic provider before the visible resume prompt is appended. That
        // would consume the tool-call phase during compaction and the real
        // resume turn would only see the final text message.
        contextWindow: 1_000_000,
        maxTokens: 16,
      },
    ],
  });

  const depthConfig = resolveDelegationDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;
  const maxParallelTasks =
    parseNonNegativeInt(process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV]) ??
    DEFAULT_MAX_PARALLEL_TASKS;

  let discoveredAgents: AgentConfig[] = [];
  let currentSessionId = "ephemeral";
  let currentSubagentSessionRoot = "";
  let pendingResumePlan: ResumableSubagentCall | null = null;
  let modelToRestoreAfterResume: any | undefined;
  const approvedProjectAgentDirsForSession = new Set<string>();

  async function restoreModelAfterResumeFailure(ctx?: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } }) {
    const restore = modelToRestoreAfterResume;
    modelToRestoreAfterResume = undefined;
    pendingResumePlan = null;
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

  // Auto-discover agents on session start
  pi.on("session_start", async (event, ctx) => {
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
      discoveredAgents = discovery.agents;
      currentSessionId = ctx.sessionManager.getSessionId?.() ?? "ephemeral";
      currentSubagentSessionRoot = getDefaultSubagentSessionRoot(ctx);

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

      const plan = findLatestResumableSubagentCall(ctx);
      if (!plan) return;

      let shouldResume = true;
      const shouldPrompt = parseBooleanEnv(process.env[SUBAGENT_RESUME_PROMPT_ENV]) !== false;
      if (ctx.hasUI && shouldPrompt) {
        shouldResume = await ctx.ui.confirm(
          "Resume subagents?",
          `The resumed session has an unfinished subagent call (${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"}). Resume it from saved subagent sessions?`,
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

      pendingResumePlan = plan;
      const resumeState = getSyntheticResumeState();
      resumeState.plan = plan;
      resumeState.phase = "tool";
      resumeState.trigger = hasCliInitialPrompt(process.argv) ? "nextRequest" : "resumePrompt";
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
      if (hasCliInitialPrompt(process.argv)) {
        if (ctx.hasUI) ctx.ui.notify(`Resuming ${plan.tasks.length} subagents...`, "info");
      } else {
        // Do not start the synthetic resume turn from session_start. Pi renders
        // the resumed chat only after session_start/resources_discover complete;
        // starting now lets that render wipe out the live tool component, so no
        // real-time updates appear. Queue it for resources_discover instead,
        // which is the last extension hook before the initial chat render.
        pendingInteractiveResumePrompt = `Resuming ${plan.tasks.length} subagents...`;
      }
    } catch (err) {
      console.error("[pi-subagent] Error in session_start:", err);
      await restoreModelAfterResumeFailure(ctx);
    }
  });

  pi.on("agent_end", async () => {
    await restoreModelAfterResumeFailure();
  });

  pi.on("resources_discover", (_event, ctx) => {
    const prompt = pendingInteractiveResumePrompt;
    if (!prompt) return;
    pendingInteractiveResumePrompt = null;
    setTimeout(() => {
      try {
        pi.sendUserMessage(prompt);
      } catch (err) {
        console.error("[pi-subagent] Failed to start deferred resume turn:", err);
        void restoreModelAfterResumeFailure(ctx);
      }
    }, RESUME_INTERACTIVE_DELAY_MS);
  });

  // Inject available agents into the system prompt
  pi.on("before_agent_start", async (event) => {
    try {
      if (!canDelegate) return;
      if (discoveredAgents.length === 0) return;

      const agentList = discoveredAgents
        .map((a) => `- **${a.name}**: ${a.description}`)
        .join("\n");
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

### How to call the subagent tool

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
- Max subagents per tool call: ${maxParallelTasks}
`,
      };
    } catch (err) {
      console.error("[pi-subagent] Error in before_agent_start:", err);
    }
  });

  // Register the subagent tool
  if (canDelegate) {
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: [
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
      ].join("\n"),
      parameters: SubagentParams,

      async execute(toolCallId, params, signal, onUpdate, ctx) {
        try {
          const discovery = discoverAgents(ctx.cwd, "both");
          const { agents } = discovery;

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
            if (ctx.hasUI) {
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

          const resumePlan =
            pendingResumePlan && sameTasks(pendingResumePlan.tasks, tasks)
              ? pendingResumePlan
              : null;
          if (resumePlan) {
            pendingResumePlan = null;
          }

          if (tasks.length === 1) {
            const [task] = tasks;
            return executeSingle(
              task.agent,
              task.task,
              task.cwd,
              agents,
              ctx.cwd,
              signal,
              onUpdate,
              makeDetails,
              resumePlan?.details?.results[0],
              getSessionDirForTask(resumePlan?.previousToolCallId ?? toolCallId, 0),
              !!resumePlan,
              formatModelFlag(modelToRestoreAfterResume),
            );
          }

          return await executeParallel(
            tasks,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
            resumePlan?.details?.results,
            (index) => getSessionDirForTask(resumePlan?.previousToolCallId ?? toolCallId, index),
            !!resumePlan,
            formatModelFlag(modelToRestoreAfterResume),
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

  async function executeSingle(
    agentName: string,
    task: string,
    cwd: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
    previousResult: SingleResult | undefined,
    sessionDir: string,
    resumeExistingSession: boolean,
    fallbackModel?: string,
  ) {
    if (previousResult && isFinishedResult(previousResult)) {
      return {
        content: [
          {
            type: "text" as const,
            text: getFinalOutput(previousResult.messages) || "(no output)",
          },
        ],
        details: makeDetails("single")([previousResult]),
      };
    }

    const result = await runAgentSubprocess({
      cwd: defaultCwd,
      agents,
      agentName,
      task,
      taskCwd: cwd,
      parentDepth: currentDepth,
      parentAgentStack: ancestorAgentStack,
      maxDepth,
      preventCycles,
      signal,
      onUpdate,
      makeDetails: makeDetails("single"),
      sessionDir: previousResult?.sessionDir ?? sessionDir,
      sessionRoot: currentSubagentSessionRoot,
      resumeSession: resumeExistingSession,
      initialResult: previousResult,
      fallbackModel,
    });

    if (isResultError(result)) {
      const errorMsg =
        result.errorMessage ||
        result.stderr ||
        getFinalOutput(result.messages) ||
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
          text: getFinalOutput(result.messages) || "(no output)",
        },
      ],
      details: makeDetails("single")([result]),
    };
  }

  async function executeParallel(
    tasks: Array<{ agent: string; task: string; cwd?: string }>,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
    resumeResults: SingleResult[] | undefined,
    getSessionDir: (index: number) => string,
    resumeExistingSessions: boolean,
    fallbackModel?: string,
  ) {
    return executeParallelSubprocess(
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
    );
  }
}
