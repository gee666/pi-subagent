/**
 * Durable subagent name registry.
 *
 * Every spawned subagent gets a unique, human-friendly name derived from its
 * agent type plus a per-type counter (e.g. `code-writer-01`, `code-writer-02`,
 * `code-reviwer-01`). Names are unique within one delegation tree (the tree
 * rooted at the top-level pi session) and are persisted in a JSON registry
 * file under the subagent session root, so they survive process restarts.
 *
 * The registry also records:
 *   - the session directory of each named subagent (for `--continue` resumes)
 *   - the owner session id (the pi session that spawned the subagent)
 *   - per-resumer fork session directories (a non-owner that resumes a name
 *     gets exactly one private fork; subsequent resumes reuse that fork)
 *
 * Because several processes in the same delegation tree may allocate names or
 * record forks concurrently, all read-modify-write operations go through a
 * best-effort directory lock with stale-lock recovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const SUBAGENT_NAMES_FILE_ENV = "PI_SUBAGENT_NAMES_FILE";

/**
 * Custom session-entry type used to persist the delegation-tree identity
 * (registry file path + stable owner id) inside the session itself. Pi copies
 * custom entries into branched sessions and keeps them across resumes, so the
 * identity survives restarts even though pi assigns the resumed/branched
 * session a brand-new session id.
 */
export const SUBAGENT_NAMES_CUSTOM_TYPE = "pi-subagent-names";

export interface SubagentNamesIdentity {
  /** Absolute path of the shared name registry for this delegation tree. */
  namesFile: string;
  /** Stable identity used as the ownership / fork key for this session. */
  ownerId: string;
}

/** True when the registry file exists and contains at least one named agent. */
function registryHasAgents(file: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return !!parsed?.agents && typeof parsed.agents === "object" && Object.keys(parsed.agents).length > 0;
  } catch {
    return false;
  }
}

/**
 * Extract the persisted names identity from session entries.
 *
 * A session may carry several identity entries (e.g. one written by a buggy
 * or interrupted run pointing at an empty registry). Preference order:
 *   1. the latest entry whose registry actually contains named agents
 *   2. the latest entry whose registry file exists
 *   3. the latest entry
 */
export function findPersistedNamesIdentity(entries: unknown): SubagentNamesIdentity | undefined {
  if (!Array.isArray(entries)) return undefined;
  const candidates: SubagentNamesIdentity[] = [];
  for (const entry of entries as any[]) {
    if (entry?.type !== "custom" || entry.customType !== SUBAGENT_NAMES_CUSTOM_TYPE) continue;
    const data = entry.data;
    if (data && typeof data.namesFile === "string" && typeof data.ownerId === "string") {
      candidates.push({ namesFile: data.namesFile, ownerId: data.ownerId });
    }
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const reversed = [...candidates].reverse();
  return (
    reversed.find((candidate) => registryHasAgents(candidate.namesFile)) ??
    reversed.find((candidate) => {
      try {
        return fs.existsSync(candidate.namesFile);
      } catch {
        return false;
      }
    }) ??
    reversed[0]
  );
}

function readSessionHeader(sessionFilePath: string): any | undefined {
  try {
    const fd = fs.openSync(sessionFilePath, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString("utf8", 0, bytes).split("\n")[0];
      const parsed = JSON.parse(firstLine);
      return parsed && typeof parsed === "object" && parsed.type === "session" ? parsed : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

const ANCESTOR_WALK_LIMIT = 20;

/**
 * Self-healing fallback for sessions that predate the persisted identity
 * entry: pi gives resumed/branched sessions a new id, but records the previous
 * session file in the header's `parentSession` chain. Walk that chain and
 * return the first ancestor whose derived registry file actually exists, along
 * with that ancestor's session id (which is what its registry used as the
 * ownership key back then).
 */
export function findAncestorNamesFile(
  sessionRoot: string,
  currentSessionId: string,
  currentHeader: any,
): { namesFile: string; ownerId: string } | undefined {
  let id: string | undefined = currentSessionId;
  let header: any = currentHeader;
  for (let depth = 0; depth < ANCESTOR_WALK_LIMIT && id; depth++) {
    const candidate = path.join(sessionRoot, sanitizePathComponent(id), "subagent-names.json");
    try {
      if (fs.existsSync(candidate)) return { namesFile: candidate, ownerId: id };
    } catch {
      /* keep walking */
    }
    const parentPath: unknown = header?.parentSession;
    if (typeof parentPath !== "string" || parentPath.length === 0) return undefined;
    header = readSessionHeader(parentPath);
    id = typeof header?.id === "string" ? header.id : undefined;
  }
  return undefined;
}

const LOCK_RETRY_INTERVAL_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 15_000;

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
  /** Per-agent-type counters used to generate the next name. */
  counters: Record<string, number>;
  /** All allocated names in this delegation tree. */
  agents: Record<string, SubagentNameRecord>;
}

export function emptyNamesRegistry(): NamesRegistry {
  return { version: 1, counters: {}, agents: {} };
}

// ---------------------------------------------------------------------------
// Registry file location
// ---------------------------------------------------------------------------

function sanitizePathComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

/**
 * Captured at module load, BEFORE this extension may set the env var itself
 * for its children. Without this, a second session in the same process (/new)
 * would wrongly inherit the previous session's registry.
 */
const INHERITED_NAMES_FILE = process.env[SUBAGENT_NAMES_FILE_ENV];

/** Registry path inherited from the parent pi process (child subagents only). */
export function getInheritedNamesFile(): string | undefined {
  return INHERITED_NAMES_FILE;
}

/**
 * Compute the registry file path for a delegation tree.
 *
 * The top-level process derives it from its own session id; children inherit
 * the exact path via PI_SUBAGENT_NAMES_FILE so the whole tree shares one
 * registry.
 */
export function getNamesFilePath(
  sessionRoot: string,
  topLevelSessionId: string,
  inherited: string | undefined = INHERITED_NAMES_FILE,
): string {
  if (inherited) return inherited;
  return path.join(sessionRoot, sanitizePathComponent(topLevelSessionId), "subagent-names.json");
}

// ---------------------------------------------------------------------------
// Locking + IO
// ---------------------------------------------------------------------------

function lockDirFor(file: string): string {
  return `${file}.lock`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(file: string): Promise<() => void> {
  const lockDir = lockDirFor(file);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      return () => {
        try {
          fs.rmdirSync(lockDir);
        } catch {
          /* already released or stolen as stale */
        }
      };
    } catch (err: any) {
      // Anything but "already exists" is a persistent FS problem (permissions,
      // a file squatting on the lock path, read-only FS, ...). Retrying would
      // spin forever, so surface it.
      if (err?.code !== "EEXIST") {
        throw new Error(`Cannot create subagent name registry lock ${lockDir}: ${err?.message ?? err}`);
      }
    }

    // Recover stale locks left behind by crashed processes. The steal is an
    // atomic rename to a unique graveyard path so concurrent stealers cannot
    // both "win"; after the rename we re-verify staleness — if we raced and
    // grabbed a *fresh* lock that replaced the stale one, we put it back.
    try {
      const stat = fs.statSync(lockDir);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        const graveyard = `${lockDir}.stale-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        try {
          fs.renameSync(lockDir, graveyard);
          const stolen = fs.statSync(graveyard);
          if (Date.now() - stolen.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(graveyard, { recursive: true, force: true });
          } else {
            try {
              fs.renameSync(graveyard, lockDir);
            } catch {
              fs.rmSync(graveyard, { recursive: true, force: true });
            }
          }
        } catch {
          /* another stealer won the rename; fall through to retry */
        }
      }
    } catch {
      /* lock vanished between mkdir failure and stat; retry */
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for subagent name registry lock: ${lockDir}`);
    }
    await sleep(LOCK_RETRY_INTERVAL_MS);
  }
}

export function readNamesRegistry(file: string): NamesRegistry {
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return emptyNamesRegistry(); // missing — start fresh
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.version === 1 &&
      parsed.counters && typeof parsed.counters === "object" &&
      parsed.agents && typeof parsed.agents === "object"
    ) {
      return parsed as NamesRegistry;
    }
  } catch {
    /* fall through to corruption handling */
  }
  // Corrupt registry: keep a backup for forensics and warn instead of
  // silently resetting (a reset restarts counters, so new names could clash
  // with names the model remembers from the conversation transcript).
  try {
    const backup = `${file}.corrupt-${Date.now().toString(36)}`;
    fs.copyFileSync(file, backup);
    console.warn(`[pi-subagent] Subagent name registry was corrupt; backed it up to ${backup} and starting fresh.`);
  } catch {
    console.warn("[pi-subagent] Subagent name registry was corrupt and could not be backed up; starting fresh.");
  }
  return emptyNamesRegistry();
}

function writeNamesRegistry(file: string, registry: NamesRegistry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Run a read-modify-write transaction against the registry file.
 */
export async function updateNamesRegistry<T>(
  file: string,
  fn: (registry: NamesRegistry) => T,
): Promise<T> {
  const release = await acquireLock(file);
  try {
    const registry = readNamesRegistry(file);
    const result = fn(registry);
    writeNamesRegistry(file, registry);
    return result;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Name allocation
// ---------------------------------------------------------------------------

export function formatSubagentName(agent: string, index: number): string {
  return `${agent}-${String(index).padStart(2, "0")}`;
}

export interface AllocateNameRequest {
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
    for (const request of requests) {
      let name: string;
      do {
        const next = (registry.counters[request.agent] ?? 0) + 1;
        registry.counters[request.agent] = next;
        name = formatSubagentName(request.agent, next);
      } while (registry.agents[name] !== undefined);
      registry.agents[name] = {
        name,
        agent: request.agent,
        task: request.task,
        ...(request.model !== undefined ? { model: request.model } : {}),
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

// ---------------------------------------------------------------------------
// Fork management
// ---------------------------------------------------------------------------

function latestSessionFile(sessionDir: string): string | undefined {
  try {
    const entries = fs.readdirSync(sessionDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const file = path.join(sessionDir, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries[0]?.file;
  } catch {
    return undefined;
  }
}

/**
 * Fork a subagent session by copying its newest session file into a new
 * directory.
 *
 * The copy is rewritten so the fork is a distinct session:
 *   - the session header id gets a `-fork-...` suffix
 *   - persisted names-identity entries get a fresh ownerId, so the forked
 *     subagent does not inherit the original's ownership of ITS OWN nested
 *     subagents (its resumes of those names fork too, instead of polluting
 *     the originals).
 */
export function forkSessionInto(originalSessionDir: string, forkSessionDir: string): boolean {
  const source = latestSessionFile(originalSessionDir);
  if (!source) return false;
  fs.mkdirSync(forkSessionDir, { recursive: true });
  const target = path.join(forkSessionDir, path.basename(source));
  const forkSuffix = `fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const lines = fs.readFileSync(source, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry = JSON.parse(lines[i]);
        if (!entry || typeof entry !== "object") continue;
        if (entry.type === "session" && typeof entry.id === "string") {
          entry.id = `${entry.id}-${forkSuffix}`;
          lines[i] = JSON.stringify(entry);
        } else if (
          entry.type === "custom" &&
          entry.customType === SUBAGENT_NAMES_CUSTOM_TYPE &&
          entry.data && typeof entry.data.ownerId === "string"
        ) {
          entry.data.ownerId = `${entry.data.ownerId}-${forkSuffix}`;
          lines[i] = JSON.stringify(entry);
        }
      } catch {
        /* leave the line untouched */
      }
    }
    fs.writeFileSync(target, lines.join("\n"), "utf8");
    return true;
  } catch {
    try {
      fs.copyFileSync(source, target);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Compute the session directory for one resumer's private fork of a name.
 */
export function buildForkSessionDir(
  namesFile: string,
  name: string,
  resumerSessionId: string,
): string {
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

// ---------------------------------------------------------------------------
// In-flight resume markers
// ---------------------------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
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
export async function clearResumeActive(
  file: string,
  name: string,
  resumerSessionId: string,
): Promise<void> {
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
