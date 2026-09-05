export interface SubagentForkRecord {
  /** Session directory of the fork (continued by the forking process). */
  sessionDir: string;
  createdAt: number;
}

export interface SubagentNameRecord {
  name: string;
  /** Agent type this name was generated from (e.g. "code-writer"). */
  agent: string;
  /** Initial task the subagent was spawned with. */
  task: string;
  /** Original branch budget. Resumes and private forks share it. */
  budget?: import("../budget.js").SubagentBudget;
  /** Model pinned by the agent config at spawn time, if any. */
  model?: string;
  /** Tool restriction from the agent config at spawn time, if any. */
  tools?: string[];
  /** Session id of the pi process that spawned this subagent (its owner). */
  ownerSessionId: string;
  /** Session directory holding the subagent's own session files. */
  sessionDir: string;
  createdAt: number;
  /** Last prompt this subagent received via resume_subagents (owner path). */
  lastResumePrompt?: string;
  /** Forks keyed by the resuming process's session id. One fork per resumer. */
  forks: Record<string, SubagentForkRecord>;
  /** In-flight resume markers keyed by resumer session id (crash-tolerant). */
  activeResumes?: Record<string, { pid: number; at: number }>;
}

export interface NamesRegistry {
  version: 1;
  /** Retained in the file shape for simple migration from older registries. */
  counters: Record<string, number>;
  /** All allocated names in this delegation tree. */
  agents: Record<string, SubagentNameRecord>;
}

export function emptyNamesRegistry(): NamesRegistry {
  return { version: 1, counters: {}, agents: {} };
}
