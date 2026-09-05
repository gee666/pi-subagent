/** Durable names and resume ownership shared by a delegation tree. */
import * as path from "node:path";
import { randomInt } from "node:crypto";
import { AGENT_NAMES } from "./agent-names.js";
import { updateNamesRegistry } from "./storage/names-registry.js";
import type { NamesRegistry, SubagentNameRecord } from "./storage/name-records.js";
import { isRecord, sanitizePathComponent } from "./storage/values.js";

export * from "./storage/names-identity.js";
export * from "./storage/name-records.js";
export { readNamesRegistry, updateNamesRegistry } from "./storage/names-registry.js";
export { forkSessionInto } from "./storage/session-fork.js";

export function getAvailableSubagentNames(registry: NamesRegistry): string[] {
  const used = new Set(Object.keys(registry.agents).map((name) => name.toLowerCase()));
  return AGENT_NAMES.filter((name) => !used.has(name.toLowerCase()));
}

export interface AllocateNameRequest {
  budget?: import("./budget.js").SubagentBudget;
  agent: string;
  task: string;
  sessionDir: string;
  model?: string;
  tools?: string[];
}

/**
 * Allocate unique names for a batch of subagents in one locked transaction.
 * Returns the generated names in request order.
 */
export async function allocateSubagentNames(
  file: string,
  ownerSessionId: string,
  requests: AllocateNameRequest[],
): Promise<string[]> {
  if (requests.length === 0) return [];
  return updateNamesRegistry(file, (registry) => {
    const names: string[] = [];
    const available = getAvailableSubagentNames(registry);
    if (available.length < requests.length) {
      throw new Error(
        `The ${AGENT_NAMES.length}-name subagent pool is exhausted (${available.length} available, ${requests.length} requested).`,
      );
    }
    for (const request of requests) {
      const selectedIndex = randomInt(available.length);
      const [name] = available.splice(selectedIndex, 1);
      registry.agents[name] = {
        name,
        agent: request.agent,
        task: request.task,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.budget !== undefined ? { budget: request.budget } : {}),
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        ownerSessionId,
        sessionDir: request.sessionDir,
        createdAt: Date.now(),
        forks: {},
      };
      names.push(name);
    }
    return names;
  });
}

/** Update the stored session dir for a name (e.g. after a resume relocation). */
export async function updateNameRecord(
  file: string,
  name: string,
  patch: Partial<Pick<SubagentNameRecord, "sessionDir" | "task" | "lastResumePrompt">>,
): Promise<void> {
  await updateNamesRegistry(file, (registry) => {
    const record = registry.agents[name];
    if (!record) return;
    if (patch.sessionDir !== undefined) record.sessionDir = patch.sessionDir;
    if (patch.task !== undefined) record.task = patch.task;
    if (patch.lastResumePrompt !== undefined) record.lastResumePrompt = patch.lastResumePrompt;
  });
}

/**
 * Compute the session directory for one resumer's private fork of a name.
 */
export function buildForkSessionDir(namesFile: string, name: string, resumerSessionId: string): string {
  return path.join(
    path.dirname(namesFile),
    "forks",
    sanitizePathComponent(name),
    sanitizePathComponent(resumerSessionId),
  );
}

export interface ResumeTargetResolution {
  /** Session directory the resume should continue. */
  sessionDir: string;
  /** True when this resume continues a fork instead of the original session. */
  isFork: boolean;
  /** True when the fork is new and its session files must still be created. */
  forkCreated: boolean;
  /** The name record at resolution time. */
  record: SubagentNameRecord;
}

/**
 * Resolve where a resume of `name` by `resumerSessionId` should continue.
 *
 * - Owner resumes continue the original session directory.
 * - Non-owner resumes get exactly one private fork (created on first resume,
 *   reused afterwards), so the owner's session is never polluted by a child's
 *   continuation.
 *
 * This is read-only: brand-new forks are NOT recorded here. Callers must copy
 * the session files first and then call commitFork(), so a failed fork never
 * leaves a dangling registry entry.
 */
export async function resolveResumeTarget(
  file: string,
  name: string,
  resumerSessionId: string,
): Promise<ResumeTargetResolution | { error: string }> {
  return updateNamesRegistry(file, (registry) => {
    const record = registry.agents[name];
    if (!record) {
      const known = Object.keys(registry.agents).sort();
      return {
        error: `Unknown subagent name "${name}". Known names: ${known.length > 0 ? known.join(", ") : "(none)"}.`,
      };
    }

    if (record.ownerSessionId === resumerSessionId) {
      return { sessionDir: record.sessionDir, isFork: false, forkCreated: false, record: { ...record } };
    }

    const existingFork = record.forks[resumerSessionId];
    if (existingFork) {
      return { sessionDir: existingFork.sessionDir, isFork: true, forkCreated: false, record: { ...record } };
    }

    return {
      sessionDir: buildForkSessionDir(file, name, resumerSessionId),
      isFork: true,
      forkCreated: true,
      record: { ...record },
    };
  });
}

/** Record a successfully created fork in the registry. */
export async function commitFork(
  file: string,
  name: string,
  resumerSessionId: string,
  sessionDir: string,
): Promise<void> {
  await updateNamesRegistry(file, (registry) => {
    const record = registry.agents[name];
    if (!record) return;
    record.forks[resumerSessionId] ??= { sessionDir, createdAt: Date.now() };
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isRecord(err) && err.code === "EPERM";
  }
}

/**
 * Mark a (name, resumer) pair as having a resume in flight. Returns an error
 * when another live process is already resuming that exact target (continuing
 * the same session file from two processes would corrupt it). Markers from
 * dead processes are treated as stale and overwritten; same-pid markers are
 * also stale because the caller already guards same-process concurrency
 * in-memory before calling this.
 */
export async function markResumeActive(
  file: string,
  name: string,
  resumerSessionId: string,
): Promise<{ ok: true } | { error: string }> {
  return updateNamesRegistry(file, (registry) => {
    const record = registry.agents[name];
    if (!record) {
      return { error: `Unknown subagent name "${name}".` };
    }
    record.activeResumes ??= {};
    const existing = record.activeResumes[resumerSessionId];
    if (existing && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      return {
        error: `Subagent "${name}" is already being resumed by another process (pid ${existing.pid}). Wait for that resume to finish.`,
      };
    }
    record.activeResumes[resumerSessionId] = { pid: process.pid, at: Date.now() };
    return { ok: true as const };
  });
}

/** Clear the in-flight resume marker for a (name, resumer) pair. */
export async function clearResumeActive(file: string, name: string, resumerSessionId: string): Promise<void> {
  try {
    await updateNamesRegistry(file, (registry) => {
      const record = registry.agents[name];
      if (!record?.activeResumes) return;
      const marker = record.activeResumes[resumerSessionId];
      if (marker && marker.pid === process.pid) {
        delete record.activeResumes[resumerSessionId];
      }
      if (record.activeResumes && Object.keys(record.activeResumes).length === 0) {
        delete record.activeResumes;
      }
    });
  } catch (err) {
    console.warn("[pi-subagent] Failed to clear resume marker:", err);
  }
}
