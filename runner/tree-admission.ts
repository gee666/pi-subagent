import { setTimeout as delay } from "node:timers/promises";
import type { TreeConcurrencyStore } from "../storage/tree-concurrency.js";
import type { BrokerEndpoint } from "../broker/contracts.js";
export { TREE_CONCURRENCY_DIR_ENV as CONCURRENCY_DIR_ENV, WORKER_TOKEN_ENV } from "../storage/tree-concurrency.js";

export class TreeAdmissionError extends Error {}

/** One subprocess attempt owns one global token. Retries must queue for a new token. */
export class TreeWorkerAdmission {
  private currentToken: string;
  private released = false;
  private bound = false;
  private boundPid?: number;
  readonly brokerEndpoint?: BrokerEndpoint;
  constructor(
    readonly store: TreeConcurrencyStore,
    private name: string,
    private parentToken?: string,
    options: { existingToken?: string; brokerEndpoint?: BrokerEndpoint } = {},
  ) {
    this.currentToken = options.existingToken ?? store.enqueue(name, parentToken);
    this.brokerEndpoint = options.brokerEndpoint;
  }
  static adopt(store: TreeConcurrencyStore, token: string, brokerEndpoint?: BrokerEndpoint): TreeWorkerAdmission {
    const entry = store.get(token);
    if (!entry) throw new TreeAdmissionError(`Unknown broker worker token: ${token}`);
    return new TreeWorkerAdmission(store, entry.name, entry.parentToken, { existingToken: token, brokerEndpoint });
  }
  get status() {
    return this.store.get(this.currentToken)?.status;
  }
  get parkingRequested(): boolean {
    return this.status === "parking";
  }
  requestPark(): boolean {
    return !!this.brokerEndpoint && this.store.requestPark(this.currentToken);
  }
  /** Keep the logical token and its descendants across an unloaded process attempt. */
  exited(pid: number): void {
    try {
      this.store.release(this.currentToken, pid);
      if (this.boundPid !== pid) return;
      this.bound = false;
      this.boundPid = undefined;
      this.released = !["suspended", "waking"].includes(this.status ?? "");
    } catch (error) {
      console.error("[pi-subagent] Could not confirm worker exit; reservation retained:", error);
    }
  }
  get directory(): string {
    return this.store.directory;
  }
  get token(): string {
    return this.currentToken;
  }
  claim() {
    return this.store.claim(this.currentToken);
  }
  get reason(): string | undefined {
    return this.store.get(this.currentToken)?.reason;
  }
  get canceled(): boolean {
    const status = this.store.get(this.currentToken)?.status;
    return status === "canceled" || status === "stopping";
  }
  async ensure(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.bound && !this.released)
      throw new Error("Previous worker process has not exited; refusing to spawn a retry.");
    if (this.released) {
      this.currentToken = this.store.enqueue(this.name, this.parentToken);
      this.released = false;
      this.bound = false;
    }
    for (;;) {
      signal?.throwIfAborted();
      if (this.status === "suspended") this.store.requestWake(this.currentToken);
      const status = this.claim();
      if (status === "running") return;
      if (status !== "queued") throw new TreeAdmissionError(this.reason ?? `Global worker admission ${status}.`);
      await delay(25, undefined, { signal });
    }
  }
  bindPid(pid: number): boolean {
    this.bound = true;
    this.boundPid = pid;
    this.store.bindPid(this.currentToken, pid);
    return this.store.get(this.currentToken)?.status === "running";
  }
  markWaiting(waiting: boolean): void {
    this.store.markWaiting(this.currentToken, waiting);
  }
  stop(): void {
    try {
      this.store.stopSubtree(this.currentToken);
    } catch (error) {
      console.error("[pi-subagent] Global stop barrier unavailable; admission remains blocked:", error);
    }
  }
  /** The store refuses to free a token while its bound PID is still alive. */
  release(): void {
    try {
      this.store.release(this.currentToken);
      this.released = !["suspended", "waking"].includes(this.status ?? "");
    } catch (error) {
      // An unreadable ledger cannot prove release. Keep this admission non-reusable.
      console.error("[pi-subagent] Global worker release failed; reservation retained:", error);
    }
  }
}
