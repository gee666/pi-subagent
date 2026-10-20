import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ResumableSubagentCall } from "../resume.js";
import { isRecord } from "./values.js";
import { findPersistedNamesIdentity, getInheritedNamesFile } from "./names-identity.js";
import { readNamesRegistry } from "./names-registry.js";
import { persistWorkerStops, readWorkerStops } from "./worker-stops.js";

export async function markStoppedNames(file: string, names: string[], at = Date.now()): Promise<void> {
  persistWorkerStops(file, names, at);
}

/** Explicit stops must not be mistaken for crashed work when automatic recovery scans history. */
export function excludeStoppedWorkers(
  plans: ResumableSubagentCall[],
  entries: SessionEntry[],
  calls: ReadonlyMap<string, { order: number }>,
): ResumableSubagentCall[] {
  const stops = new Map<string, number>();
  entries.forEach((entry, order) => {
    if (entry.type !== "message") return;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "stop_subagent" || !isRecord(message.details)) return;
    const stoppedNames = message.details.stoppedNames;
    if (Array.isArray(stoppedNames))
      for (const name of stoppedNames) if (typeof name === "string") stops.set(name, order);
    const statuses = message.details.statuses;
    if (!Array.isArray(statuses)) return;
    for (const status of statuses) {
      if (
        isRecord(status) &&
        typeof status.name === "string" &&
        ["stopped", "canceled"].includes(String(status.status))
      )
        stops.set(status.name, order);
    }
  });
  const file = findPersistedNamesIdentity(entries)?.namesFile ?? getInheritedNamesFile();
  const records = file ? readNamesRegistry(file).agents : {};
  const persisted = file ? readWorkerStops(file) : new Map<string, number>();
  if (!stops.size && !persisted.size && !Object.values(records).some((record) => record.stoppedAt !== undefined))
    return plans;
  return plans.flatMap((plan) => {
    const order = calls.get(plan.previousToolCallId)?.order ?? Infinity;
    const keep = plan.tasks.map((_task, index) => {
      const result = plan.details?.results[index];
      const name = result?.name;
      if (!name) return true;
      if ((stops.get(name) ?? -1) > order) return false;
      const stoppedAt = persisted.get(name) ?? records[name]?.stoppedAt;
      return stoppedAt === undefined || (result?.startedAt ?? records[name]?.createdAt ?? 0) > stoppedAt;
    });
    if (keep.every(Boolean)) return [plan];
    if (!keep.some(Boolean)) return [];
    return [
      {
        ...plan,
        tasks: plan.tasks.filter((_task, index) => keep[index]),
        details: plan.details
          ? { ...plan.details, results: plan.details.results.filter((_result, index) => keep[index]) }
          : undefined,
      },
    ];
  });
}
