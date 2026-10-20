import type { AgentConfig } from "../agents.js";
import type { SubagentBudget } from "../budget.js";
import type { IntelligencePreset } from "../intelligence.js";
import type { SubagentSettings } from "../settings.js";
import type { SubagentModelSettings } from "../storage/name-records.js";
import type { SingleResult } from "../types.js";

export const BROKER_DIR_ENV = "PI_SUBAGENT_BROKER_DIR";
export const BROKER_SECRET_ENV = "PI_SUBAGENT_BROKER_SECRET";

export interface BrokerEndpoint {
  directory: string;
  secret: string;
}
export interface BrokerManifest {
  version: 1;
  rootPid: number;
  rootStartTime?: string;
  concurrencyDirectory: string;
}

/** A root-owned task. No callbacks, process-local closures, or AbortSignals cross the boundary. */
export interface BrokerJobSpec {
  version: 1;
  id: string;
  token: string;
  ownerToken: string;
  ownerId: string;
  toolCallId: string;
  taskIndex: number;
  name: string;
  submittedAt?: number;
  agents: AgentConfig[];
  task: { agent: string; task: string; intelligence?: string };
  cwd: string;
  settings?: SubagentSettings;
  projectTrusted: boolean;
  parentDepth: number;
  maxDepth: number;
  parentAgentStack: string[];
  preventCycles: boolean;
  budget?: SubagentBudget;
  sessionDir: string;
  sessionRoot: string;
  namesFile: string;
  resumeSession: boolean;
  initialResult?: SingleResult;
  fallbackModel?: string;
  resumeSettings?: SubagentModelSettings;
  intelligencePresets?: IntelligencePreset[];
}
export type BrokerSubmission = Omit<BrokerJobSpec, "version" | "id" | "token">;
export interface BrokerReceipt {
  id: string;
  token: string;
  name: string;
  status: "queued";
}
export interface BrokerResult {
  version: 1;
  id: string;
  result: SingleResult;
}
