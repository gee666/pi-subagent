import * as fs from "node:fs";
import * as path from "node:path";
import { acquireNamesLock } from "./names-lock.js";
import { emptyNamesRegistry, type NamesRegistry, type SubagentNameRecord } from "./name-records.js";
import { isRecord } from "./values.js";

function isNameRecord(value: unknown): value is SubagentNameRecord {
  if (!isRecord(value)) return false;
  const strings = ["name", "agent", "task", "ownerSessionId", "sessionDir"];
  if (!strings.every((key) => typeof value[key] === "string") || typeof value.createdAt !== "number") return false;
  if (
    !isRecord(value.forks) ||
    !Object.values(value.forks).every(
      (fork) => isRecord(fork) && typeof fork.sessionDir === "string" && typeof fork.createdAt === "number",
    )
  )
    return false;
  if (
    value.activeResumes !== undefined &&
    (!isRecord(value.activeResumes) ||
      !Object.values(value.activeResumes).every(
        (marker) => isRecord(marker) && typeof marker.pid === "number" && typeof marker.at === "number",
      ))
  )
    return false;
  if (value.budget !== undefined && (!isRecord(value.budget) || typeof value.budget.directory !== "string"))
    return false;
  if (
    value.tools !== undefined &&
    (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string"))
  )
    return false;
  return ["model", "lastResumePrompt"].every((key) => value[key] === undefined || typeof value[key] === "string");
}

function isNamesRegistry(value: unknown): value is NamesRegistry {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.counters) &&
    Object.values(value.counters).every((count) => typeof count === "number") &&
    isRecord(value.agents) &&
    Object.values(value.agents).every(isNameRecord)
  );
}

export function readNamesRegistry(file: string): NamesRegistry {
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return emptyNamesRegistry(); // missing — start fresh
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isNamesRegistry(parsed)) return parsed;
  } catch {
    /* fall through to corruption handling */
  }
  // Corrupt registry: keep a backup for forensics and warn instead of
  // silently resetting (a reset could reuse names the model remembers from
  // the conversation transcript).
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
export async function updateNamesRegistry<T>(file: string, fn: (registry: NamesRegistry) => T): Promise<T> {
  const release = await acquireNamesLock(file);
  try {
    const registry = readNamesRegistry(file);
    const result = fn(registry);
    writeNamesRegistry(file, registry);
    return result;
  } finally {
    release();
  }
}
