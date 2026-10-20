import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { commitLedger, readLedger } from "./tree-concurrency-ledger.js";
import { processIdentity, processIsAlive, sameProcess } from "./tree-concurrency-process.js";
import {
  nextAdmission,
  requestBlockedParks,
  requestParkEntry,
  requestWakeEntry,
} from "./tree-concurrency-lifecycle.js";
import {
  admitted,
  ancestors,
  cancelEntry,
  lineageOpen,
  maintain,
  publicEntry,
  validLimit,
  type TreeConcurrencyClaim,
  type TreeConcurrencyEntry,
  type TreeConcurrencyState,
} from "./tree-concurrency-state.js";

export type { TreeConcurrencyClaim, TreeConcurrencyEntry, TreeConcurrencyStatus } from "./tree-concurrency-state.js";
export const TREE_CONCURRENCY_DIR_ENV = "PI_SUBAGENT_CONCURRENCY_DIR";
export const WORKER_TOKEN_ENV = "PI_SUBAGENT_WORKER_TOKEN";

/** Check immediately before signaling a PID obtained from a snapshot. */
export function matchesProcess(pid: number, startTime?: string): boolean {
  return processIsAlive({ pid, startTime });
}

export class TreeConcurrencyStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
    readLedger(this.directory);
  }

  private transaction<T>(change: (state: TreeConcurrencyState) => T): T {
    const deadline = Date.now() + 10_000;
    do {
      const { revision, state } = readLedger(this.directory);
      const before = JSON.stringify(state);
      maintain(state);
      requestBlockedParks(state);
      const result = change(state);
      maintain(state);
      requestBlockedParks(state);
      if (before === JSON.stringify(state) || commitLedger(this.directory, revision + 1, state)) return result;
    } while (Date.now() < deadline);
    throw new Error("Global tree concurrency contention timed out; launches blocked");
  }

  enqueue(name: string, parentToken?: string, ownerPid = process.pid): string {
    if (typeof name !== "string" || !name) throw new Error("Worker name must not be empty");
    if (parentToken !== undefined && typeof parentToken !== "string") throw new Error("Invalid parent worker token");
    const token = randomUUID();
    const owner = processIdentity(ownerPid);
    return this.transaction((state) => {
      const parent = parentToken ? state.entries.find((entry) => entry.token === parentToken) : undefined;
      if (parentToken && !parent) throw new Error(`Unknown parent worker token: ${parentToken}`);
      const blocked = parent && [parent, ...ancestors(state, parent)].some((entry) => !lineageOpen(entry));
      state.entries.push({
        token,
        name,
        parentToken,
        ownerPid,
        owner,
        status: blocked ? "canceled" : "queued",
        ...(blocked ? { reason: "Parent subtree has stopped or exited" } : {}),
      });
      return token;
    });
  }

  claim(token: string): TreeConcurrencyClaim {
    return this.transaction((state) => {
      const entry = state.entries.find((candidate) => candidate.token === token);
      if (!entry) throw new Error(`Unknown worker token: ${token}`);
      if (entry.status === "running") return "running";
      if (entry.status === "rejected") return "rejected";
      if (entry.status === "parking" || entry.status === "suspended") return "queued";
      if (entry.status !== "queued" && entry.status !== "waking") return "canceled";
      if (state.entries.filter(admitted).length < state.limit && nextAdmission(state) === entry) {
        entry.status = "running";
        entry.waitingForChildren = false;
        delete entry.wakeOrder;
        delete entry.reason;
        return "running";
      }
      return "queued";
    });
  }

  /** Always record the PID, including a stop racing between claim and spawn. */
  bindPid(token: string, pid: number): void {
    const worker = processIdentity(pid);
    this.transaction((state) => {
      const entry = state.entries.find((candidate) => candidate.token === token);
      if (!entry) throw new Error(`Unknown worker token: ${token}`);
      if (entry.worker && processIsAlive(entry.worker) && !sameProcess(entry.worker, worker)) {
        throw new Error("Cannot replace a live worker PID before its process exits");
      }
      if (!admitted(entry)) throw new Error("Cannot bind worker PID without a running reservation");
      entry.worker = worker;
      entry.pid = pid;
      if (entry.status === "stopping") {
        entry.status = "stopping";
        entry.reason ??= "Worker was stopped before PID binding; terminate this process";
      }
    });
  }

  /** Caller acknowledges spawn was aborted, or the bound process has exited. */
  release(token: string, expectedPid?: number): void {
    this.transaction((state) => {
      const entry = state.entries.find((candidate) => candidate.token === token);
      if (!entry || entry.status === "suspended" || entry.status === "waking") return;
      // A parked attempt's delayed exit callback must not release a new wake reservation.
      if (expectedPid !== undefined && entry.pid !== expectedPid) return;
      if (entry.worker && processIsAlive(entry.worker)) return;
      if (!entry.worker && admitted(entry) && !sameProcess(entry.owner, processIdentity(process.pid))) {
        throw new Error("Only the reservation owner may acknowledge an aborted spawn");
      }
      if (entry.status !== "canceled" && entry.status !== "rejected") entry.status = "released";
      entry.waitingForChildren = false;
    });
  }

  setLimit(limit: number): void {
    if (!validLimit(limit)) throw new Error("Global concurrency limit must be a positive safe integer");
    this.transaction((state) => {
      if (!sameProcess(state.root, processIdentity(process.pid))) {
        throw new Error("Only the root process may change the global concurrency limit");
      }
      state.limit = limit;
    });
  }

  getLimit(): number {
    return this.transaction((state) => state.limit);
  }

  get limit(): number {
    return this.getLimit();
  }

  get(token: string): TreeConcurrencyEntry | undefined {
    return this.transaction((state) => {
      const entry = state.entries.find((candidate) => candidate.token === token);
      return entry && publicEntry(entry);
    });
  }

  snapshot(): TreeConcurrencyEntry[] {
    return this.transaction((state) => state.entries.map(publicEntry));
  }

  isProcessAlive(entry: TreeConcurrencyEntry): boolean {
    return entry.pid !== undefined && matchesProcess(entry.pid, entry.pidStartTime);
  }

  markWaiting(token: string, waitingForChildren: boolean): void {
    if (typeof waitingForChildren !== "boolean") throw new Error("Invalid worker waiting state");
    this.transaction((state) => {
      const entry = state.entries.find((candidate) => candidate.token === token);
      if (!entry) throw new Error(`Unknown worker token: ${token}`);
      if (admitted(entry)) entry.waitingForChildren = waitingForChildren;
      if (!waitingForChildren && entry.status === "parking") {
        entry.status = "running";
        delete entry.reason;
      }
    });
  }

  /** The broker persists a launch descriptor before transferring its ownership. */
  adopt(token: string, ownerPid = process.pid): void {
    const owner = processIdentity(ownerPid);
    this.transaction((state) => {
      if (!sameProcess(state.root, processIdentity(process.pid)))
        throw new Error("Only the root process may adopt worker jobs");
      const entry = state.entries.find((candidate) => candidate.token === token);
      if (!entry) throw new Error(`Unknown worker token: ${token}`);
      if (!processIsAlive(owner)) throw new Error("Cannot adopt worker job into a dead owner");
      entry.owner = owner;
      entry.ownerPid = ownerPid;
    });
  }

  getRootPid(): number {
    return this.transaction((state) => state.root.pid);
  }

  requestPark(token: string): boolean {
    return this.transaction((state) => {
      const entry = state.entries.find((candidate) => candidate.token === token);
      if (!entry) throw new Error(`Unknown worker token: ${token}`);
      return requestParkEntry(state, entry);
    });
  }

  requestWake(token: string): boolean {
    return this.transaction((state) => {
      const entry = state.entries.find((candidate) => candidate.token === token);
      if (!entry) throw new Error(`Unknown worker token: ${token}`);
      return requestWakeEntry(state, entry);
    });
  }

  /** Commit tombstones before the caller sends signals. No slots are released. */
  stopSubtree(nameOrToken: string): TreeConcurrencyEntry[] {
    return this.transaction((state) => {
      const roots = new Set(
        state.entries
          .filter((entry) => entry.token === nameOrToken || entry.name === nameOrToken)
          .map((entry) => entry.token),
      );
      const affected = state.entries.filter(
        (entry) => roots.has(entry.token) || ancestors(state, entry).some((parent) => roots.has(parent.token)),
      );
      for (const entry of affected) cancelEntry(entry, "Worker subtree stopped");
      return affected.map(publicEntry);
    });
  }
}

export interface TreeConcurrencyOptions {
  directory?: string;
  limit?: number;
}

/** Existing/inherited generations always retain their authoritative root cap. */
export function createTreeConcurrencyStore(options: TreeConcurrencyOptions = {}): TreeConcurrencyStore {
  const inherited = !options.directory && process.env[TREE_CONCURRENCY_DIR_ENV];
  if (inherited) return openTreeConcurrencyStore(inherited);
  if (options.directory && fs.existsSync(options.directory)) return openTreeConcurrencyStore(options.directory);
  const limit = options.limit ?? 1;
  if (!validLimit(limit)) throw new Error("Global concurrency limit must be a positive safe integer");
  let directory = options.directory;
  if (!directory) {
    const temporaryRoot = path.resolve("tmp");
    fs.mkdirSync(temporaryRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(temporaryRoot, "tree-concurrency-"));
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  commitLedger(directory, 0, { version: 1, limit, root: processIdentity(process.pid), entries: [] });
  return openTreeConcurrencyStore(directory);
}

export function openTreeConcurrencyStore(directory: string): TreeConcurrencyStore {
  return new TreeConcurrencyStore(directory);
}
