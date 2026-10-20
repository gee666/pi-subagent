import { processIsAlive, sameProcess } from "./tree-concurrency-process.js";
import {
  admitted,
  ancestors,
  lineageOpen,
  type StoredEntry,
  type TreeConcurrencyState,
} from "./tree-concurrency-state.js";

/** Only durable root-broker jobs may outlive an unloaded parent process. */
export function requestParkEntry(state: TreeConcurrencyState, entry: StoredEntry): boolean {
  if (entry.status === "parking") return true;
  if (
    entry.status !== "running" ||
    !entry.waitingForChildren ||
    !entry.worker ||
    !processIsAlive(entry.worker) ||
    state.entries.filter(admitted).length < state.limit
  )
    return false;
  const descendants = state.entries.filter(
    (candidate) => lineageOpen(candidate) && ancestors(state, candidate).some((parent) => parent.token === entry.token),
  );
  if (
    !descendants.some((candidate) => candidate.status === "queued" || candidate.status === "waking") ||
    !descendants.every((candidate) => sameProcess(candidate.owner, state.root))
  )
    return false;
  entry.status = "parking";
  entry.reason = "Parent parking to admit root-broker-owned children";
  return true;
}

export function requestBlockedParks(state: TreeConcurrencyState): void {
  for (const entry of state.entries) requestParkEntry(state, entry);
}

export function requestWakeEntry(state: TreeConcurrencyState, entry: StoredEntry): boolean {
  if (entry.status === "waking") return true;
  if (entry.status !== "suspended") return false;
  const sequence = state.nextWakeOrder ?? 1;
  if (!Number.isSafeInteger(sequence + 1)) throw new Error("Global wake queue sequence exhausted");
  entry.status = "waking";
  entry.wakeOrder = sequence;
  state.nextWakeOrder = sequence + 1;
  entry.reason = "Parent resume queued behind ordinary work";
  return true;
}

/** Ordinary jobs keep FIFO priority. Wake descendants before ancestors, with FIFO peers. */
export function nextAdmission(state: TreeConcurrencyState): StoredEntry | undefined {
  return (
    state.entries.find((entry) => entry.status === "queued") ??
    state.entries
      .filter((entry) => entry.status === "waking")
      .reduce<StoredEntry | undefined>((first, entry) => {
        if (!first) return entry;
        const depth = ancestors(state, entry).length,
          firstDepth = ancestors(state, first).length;
        return depth > firstDepth || (depth === firstDepth && entry.wakeOrder! < first.wakeOrder!) ? entry : first;
      }, undefined)
  );
}
