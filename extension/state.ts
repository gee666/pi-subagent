import { configuredEnv, type SubagentSettings } from "../settings.js";
import { subagentDisabled } from "../runner/extension-policy.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../agents.js";
import type { SubagentBudget } from "../budget.js";
import { loadPiSubagentsConfig, type PiSubagentsConfig } from "../config.js";
import type { ResumableSubagentCall } from "../resume.js";
import type { RunningSubagentHandle } from "../runner.js";
import { DEFAULT_MAX_PARALLEL_TASKS, parseNonNegativeInt, SUBAGENT_MAX_PARALLEL_TASKS_ENV } from "../shared.js";
import type { SubagentUsageSummary } from "../types.js";
import type { BroadcastTarget } from "./broadcast.js";
import type { ResumeModel, ResumeModelRegistry, SessionContext } from "./contracts.js";
import type { SyntheticResumeState } from "./models.js";
import { resolveDelegationDepthConfig, type DelegationDepthConfig } from "./policy.js";

export interface ExtensionState extends DelegationDepthConfig {
  pi: ExtensionAPI;
  settings?: SubagentSettings;
  disabled?: boolean;
  toolsRegistered?: boolean;
  registeredConfigKey?: string;
  resumeToolRegistered?: boolean;
  resumesEnabled?: boolean;
  configuredToolPrompts: Record<string, string>;
  intelligencePresets?: PiSubagentsConfig["intelligencePresets"];
  refreshRegisteredToolPrompts?: (cwd: string, includeProject: boolean, config?: PiSubagentsConfig) => void;
  resumeModelRegistry?: ResumeModelRegistry;
  lastRestorableModel?: ResumeModel;
  latestSessionCtx?: SessionContext;
  pendingInteractiveResumePrompt: string | null;
  lifecycleGeneration: number;
  sessionActive: boolean;
  scheduledTasks: Set<ReturnType<typeof setTimeout>>;
  resumeState: SyntheticResumeState;
  maxParallelTasks: number;
  discoveredAgents: AgentConfig[];
  currentSessionId: string;
  currentSubagentSessionRoot: string;
  currentNamesFile: string;
  currentOwnerId: string;
  currentBudget?: SubagentBudget;
  budgetSetupError?: unknown;
  pendingResumePlans: ResumableSubagentCall[];
  recoveryPlansByToolCallId?: Map<string, ResumableSubagentCall>;
  modelToRestoreAfterResume?: ResumeModel;
  approvedProjectAgentDirsForSession: Set<string>;
  activeSubagents: Map<number, { agent: string; task: string; handle: RunningSubagentHandle; name?: string }>;
  activeResumeNames: Set<string>;
  forcedErrorToolCallIds: Set<string>;
  activeSubagentUsageSummaries: Map<string, SubagentUsageSummary>;
  latestBroadcastTargets: { all: BroadcastTarget[]; youngest: BroadcastTarget[] };
  nextActiveSubagentId: number;
}

export function createExtensionState(pi: ExtensionAPI): ExtensionState {
  const config = loadPiSubagentsConfig();
  const depth = resolveDelegationDepthConfig(pi, config.settings);
  const disabled = subagentDisabled(process.env, config.settings);
  return {
    settings: config.settings,
    pi,
    ...depth,
    disabled,
    canDelegate: !disabled && depth.canDelegate,
    configuredToolPrompts: config.toolPrompts,
    pendingInteractiveResumePrompt: null,
    lifecycleGeneration: 0,
    sessionActive: false,
    scheduledTasks: new Set(),
    resumeState: { plans: [], phase: "tool", trigger: "resumePrompt" },
    maxParallelTasks:
      parseNonNegativeInt(configuredEnv(SUBAGENT_MAX_PARALLEL_TASKS_ENV, config.settings)) ??
      DEFAULT_MAX_PARALLEL_TASKS,
    discoveredAgents: [],
    currentSessionId: "ephemeral",
    currentSubagentSessionRoot: "",
    currentNamesFile: "",
    currentOwnerId: "ephemeral",
    pendingResumePlans: [],
    approvedProjectAgentDirsForSession: new Set(),
    activeSubagents: new Map(),
    activeResumeNames: new Set(),
    forcedErrorToolCallIds: new Set(),
    activeSubagentUsageSummaries: new Map(),
    latestBroadcastTargets: { all: [], youngest: [] },
    nextActiveSubagentId: 1,
  };
}
