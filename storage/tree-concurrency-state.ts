import { processIsAlive, type ProcessIdentity } from "./tree-concurrency-process.js";

export type TreeConcurrencyStatus =
  "queued" | "running" | "parking" | "suspended" | "waking" | "stopping" | "canceled" | "rejected" | "released";
export type TreeConcurrencyClaim = "queued" | "running" | "canceled" | "rejected";
export interface TreeConcurrencyEntry {
  token: string;
  name: string;
  parentToken?: string;
  ownerPid: number;
  pid?: number;
  ownerStartTime?: string;
  pidStartTime?: string;
  status: TreeConcurrencyStatus;
  waitingForChildren?: boolean;
  wakeOrder?: number;
  reason?: string;
}
export interface StoredEntry extends TreeConcurrencyEntry {
  owner: ProcessIdentity;
  worker?: ProcessIdentity;
}
export interface TreeConcurrencyState {
  version: 1;
  limit: number;
  root: ProcessIdentity;
  nextWakeOrder?: number;
  entries: StoredEntry[];
}

export function validLimit(limit: number): boolean {
  return Number.isSafeInteger(limit) && limit >= 1;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function identity(value: unknown): value is ProcessIdentity {
  return (
    record(value) &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    (value.startTime === undefined || typeof value.startTime === "string")
  );
}

export function decodeState(value: unknown): TreeConcurrencyState {
  if (
    !record(value) ||
    value.version !== 1 ||
    !validLimit(Number(value.limit)) ||
    typeof value.limit !== "number" ||
    !identity(value.root) ||
    !Array.isArray(value.entries) ||
    (value.nextWakeOrder !== undefined && (typeof value.nextWakeOrder !== "number" || !validLimit(value.nextWakeOrder)))
  ) {
    throw new Error("Invalid tree concurrency state");
  }
  const tokens = new Set<string>();
  for (const entry of value.entries) {
    if (
      !record(entry) ||
      typeof entry.token !== "string" ||
      !entry.token ||
      tokens.has(entry.token) ||
      typeof entry.name !== "string" ||
      !identity(entry.owner) ||
      entry.owner.pid !== entry.ownerPid ||
      !["queued", "running", "parking", "suspended", "waking", "stopping", "canceled", "rejected", "released"].includes(
        String(entry.status),
      ) ||
      (entry.parentToken !== undefined && (typeof entry.parentToken !== "string" || !tokens.has(entry.parentToken))) ||
      (entry.worker !== undefined && (!identity(entry.worker) || entry.worker.pid !== entry.pid)) ||
      (entry.pid !== undefined && entry.worker === undefined) ||
      (entry.waitingForChildren !== undefined && typeof entry.waitingForChildren !== "boolean") ||
      (entry.wakeOrder !== undefined && (typeof entry.wakeOrder !== "number" || !validLimit(entry.wakeOrder))) ||
      (entry.status === "waking" && entry.wakeOrder === undefined) ||
      (entry.reason !== undefined && typeof entry.reason !== "string")
    ) {
      throw new Error("Invalid tree concurrency entry");
    }
    tokens.add(entry.token);
  }
  return value as unknown as TreeConcurrencyState;
}

export function admitted(entry: StoredEntry): boolean {
  return entry.status === "running" || entry.status === "parking" || entry.status === "stopping";
}

/** Parked ancestors remain logical parents, unlike terminal stop tombstones. */
export function lineageOpen(entry: StoredEntry): boolean {
  return ["queued", "running", "parking", "suspended", "waking"].includes(entry.status);
}

export function publicEntry(entry: StoredEntry): TreeConcurrencyEntry {
  const { owner: _owner, worker: _worker, ...result } = entry;
  return { ...result, ownerStartTime: entry.owner.startTime, pidStartTime: entry.worker?.startTime };
}

export function ancestors(state: TreeConcurrencyState, entry: StoredEntry): StoredEntry[] {
  const result: StoredEntry[] = [];
  let token = entry.parentToken;
  while (token) {
    const parent = state.entries.find((candidate) => candidate.token === token);
    if (!parent) break;
    result.push(parent);
    token = parent.parentToken;
  }
  return result;
}

export function cancelEntry(entry: StoredEntry, reason: string): void {
  if (lineageOpen(entry) && !admitted(entry)) entry.status = "canceled";
  else if (admitted(entry)) entry.status = "stopping";
  entry.reason = reason;
}

export function suspendEntry(entry: StoredEntry): void {
  entry.status = "suspended";
  delete entry.worker;
  delete entry.pid;
  entry.reason = "Parent suspended while waiting for children";
}

/** Cleanup never trusts owner death as evidence that a bound worker also died. */
export function maintain(state: TreeConcurrencyState): void {
  for (const entry of state.entries) {
    if ((entry.status === "queued" || entry.status === "waking") && !processIsAlive(entry.owner)) {
      cancelEntry(entry, "Worker owner exited before admission");
    } else if (admitted(entry)) {
      if (entry.worker && !processIsAlive(entry.worker)) {
        if (entry.status === "parking") suspendEntry(entry);
        else {
          entry.status = "released";
          entry.waitingForChildren = false;
          entry.reason ??= "Worker process exited";
        }
      } else if (!entry.worker && !processIsAlive(entry.owner)) {
        entry.status = "stopping";
        entry.reason = "Owner exited before binding worker PID; reservation retained for safety";
      }
    }
    if (
      (entry.status === "queued" || entry.status === "waking") &&
      ancestors(state, entry).some((parent) => !lineageOpen(parent))
    ) {
      cancelEntry(entry, "Parent subtree has stopped or exited");
    }
  }
}
