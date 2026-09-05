import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentConfig } from "../agents.js";
import type { SingleResult, SubagentDetails } from "../types.js";
import type { SubagentBudget } from "../budget.js";
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
export type DetailsFactory = ((results: SingleResult[]) => SubagentDetails) & {
  live?: (results: SingleResult[]) => SubagentDetails;
};

export interface RunningSubagentHandle {
  steer(message: string): void;
}

export type RunningSubagentStartedCallback = (handle: RunningSubagentHandle) => void;

export interface RunAgentOptions {
  /** Working directory inherited by every subagent process. */
  cwd: string;
  /** All available agent configs. */
  agents: AgentConfig[];
  /** Name of the agent to run. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Unique resumable human name assigned to this subagent (e.g. "John"). */
  subagentName?: string;
  /** Reserved branch allowance. Reused on retries and resumes. */
  budget?: SubagentBudget;
  /** When true, send the task text to the child verbatim (no "Task:" / resume preamble). */
  rawPrompt?: boolean;
  /** Current delegation depth of the caller process. */
  parentDepth: number;
  /** Delegation stack from the caller process (ancestor agent names). */
  parentAgentStack: string[];
  /** Maximum allowed delegation depth to propagate to child processes. */
  maxDepth: number;
  /** Whether cycle prevention should be enforced in child processes. */
  preventCycles: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Factory to wrap results into durable SubagentDetails. Optional .live keeps transient TUI state. */
  makeDetails: DetailsFactory;
  /** Dedicated session directory for this subagent process. */
  sessionDir?: string;
  /** Top-level root for all subagent session directories in this delegation tree. */
  sessionRoot?: string;
  /**
   * Shared name-registry file for this delegation tree, passed to the child
   * via its spawn environment. Deliberately NOT set on process.env of the
   * parent itself: pi reloads extension modules on session switches, and a
   * self-set env var would then masquerade as "inherited from a parent".
   */
  namesFile?: string;
  /** Continue the most recent session in sessionDir instead of creating a new one. */
  resumeSession?: boolean;
  /** Previously captured state for this same subagent, used to render resumed nested trees. */
  initialResult?: SingleResult;
  /** Fallback model to use when the agent config does not pin one. */
  fallbackModel?: string;
  /** Test/debug override for the spawned pi executable. */
  piCommandOverride?: { command: string; argsPrefix?: string[] };
  /** Test/debug override for startup timeout. */
  startupTimeoutMsOverride?: number;
  /** Test/debug override for post-startup semantic inactivity timeout. */
  idleTimeoutMsOverride?: number;
  /** Test/debug override for graceful-stop to SIGKILL escalation. */
  terminationTimeoutMsOverride?: number;
  /** Called once the child RPC process is ready to receive steering messages. */
  onHandle?: RunningSubagentStartedCallback;
}
