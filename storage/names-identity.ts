import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord, sanitizePathComponent } from "./values.js";

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
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) && isRecord(parsed.agents) && Object.keys(parsed.agents).length > 0;
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
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SUBAGENT_NAMES_CUSTOM_TYPE) continue;
    const data = entry.data;
    if (isRecord(data) && typeof data.namesFile === "string" && typeof data.ownerId === "string") {
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

function readSessionHeader(sessionFilePath: string): Record<string, unknown> | undefined {
  try {
    const fd = fs.openSync(sessionFilePath, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.toString("utf8", 0, bytes).split("\n")[0];
      const parsed: unknown = JSON.parse(firstLine);
      return isRecord(parsed) && parsed.type === "session" ? parsed : undefined;
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
  currentHeader: unknown,
): { namesFile: string; ownerId: string } | undefined {
  let id: string | undefined = currentSessionId;
  let header = isRecord(currentHeader) ? currentHeader : undefined;
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
