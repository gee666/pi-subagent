import type { TreeConcurrencyStore } from "../storage/tree-concurrency.js";
import type { BrokerEndpoint } from "../broker/contracts.js";
import { TreeAdmissionError, TreeWorkerAdmission } from "./tree-admission.js";

export type WorkerStatus = "started" | "queued" | "stopping" | "parked";
export interface WorkerTicket<T> {
  name: string;
  readonly status: WorkerStatus;
  controller: AbortController;
  promise: Promise<T>;
}
type Entry = Omit<WorkerTicket<unknown>, "status"> & {
  status: WorkerStatus;
  run?: () => Promise<unknown>;
  admission?: TreeWorkerAdmission;
  remote?: boolean;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
  onCancel?: () => void;
  steer?: (message: string) => boolean | void | Promise<boolean | void>;
  messages: Array<{ message: string; resolve: (value: boolean | void) => void; reject: (reason: unknown) => void }>;
};

/** FIFO admission for one owner session. A stopping process keeps its slot until it exits. */
export class WorkerScheduler {
  private entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private active = 0;
  private closed = false;
  private limit: number;
  private poll?: ReturnType<typeof setTimeout>;

  constructor(
    limit: number,
    private tree?: {
      store: TreeConcurrencyStore;
      parentToken?: string;
      root?: boolean;
      brokerEndpoint?: BrokerEndpoint;
    },
  ) {
    this.limit = this.normalize(limit);
  }
  get treeStore(): TreeConcurrencyStore | undefined {
    return this.tree?.store;
  }
  get brokerEndpoint(): BrokerEndpoint | undefined {
    return this.tree?.brokerEndpoint;
  }
  private normalize(limit: number): number {
    return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  }
  get concurrency(): number {
    return this.tree?.store.getLimit() ?? this.limit;
  }
  setLimit(limit: number): void {
    this.limit = this.normalize(limit);
    if (this.tree?.root) this.tree.store.setLimit(this.limit);
    this.drain();
  }
  snapshot(): Array<{ name: string; status: WorkerStatus }> {
    return [...this.entries.values()].map(({ name, status }) => ({ name, status }));
  }
  /** Register an idle resume before asynchronous session preparation. It owns no running slot yet. */
  prepare(name: string, options: { signal?: AbortSignal; onCancel?: () => void } = {}): WorkerTicket<unknown> {
    if (this.closed) throw new Error("Worker scheduler is shut down.");
    if (this.entries.has(name)) throw new Error(`Subagent "${name}" already has scheduled work.`);
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<unknown>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Owners attach handlers after synchronous admission of the whole batch.
    void promise.catch(() => undefined);
    const source = options.signal ? AbortSignal.any([options.signal]) : undefined;
    const abort = () => this.stop(name);
    const entry: Entry = {
      name,
      status: "queued",
      controller,
      promise,
      resolve,
      reject,
      detach: () => {
        source?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", cancel);
      },
      onCancel: options.onCancel,
      admission: this.tree
        ? new TreeWorkerAdmission(this.tree.store, name, this.tree.parentToken, {
            brokerEndpoint: this.tree.brokerEndpoint,
          })
        : undefined,
      messages: [],
    };
    const cancel = () => this.cancel(entry);
    this.entries.set(name, entry);
    this.queue.push(entry);
    controller.signal.addEventListener("abort", cancel, { once: true });
    source?.addEventListener("abort", abort, { once: true });
    if (source?.aborted) controller.abort(source.reason);
    if (this.tree) this.drain(); // Preparation is globally visible but cannot claim a spawn slot yet.
    return entry;
  }
  schedule<T>(
    name: string,
    run: (signal: AbortSignal, admission?: TreeWorkerAdmission) => Promise<T>,
    options: { signal?: AbortSignal; onCancel?: () => void; remote?: boolean } = {},
  ): WorkerTicket<T> {
    const existing = this.entries.get(name);
    if (existing?.run) throw new Error(`Subagent "${name}" already has scheduled work.`);
    const entry = (existing ?? this.prepare(name, options)) as Entry;
    entry.remote = options.remote;
    entry.run = () => run(entry.controller.signal, entry.admission);
    if (existing) {
      // Detach only preparation's source. Keep controller cancellation wired after activation.
      entry.detach();
      const cancel = () => this.cancel(entry);
      entry.controller.signal.addEventListener("abort", cancel, { once: true });
      const source = options.signal ? AbortSignal.any([options.signal]) : undefined;
      const abort = () => entry.controller.abort(source?.reason);
      source?.addEventListener("abort", abort, { once: true });
      entry.detach = () => {
        source?.removeEventListener("abort", abort);
        entry.controller.signal.removeEventListener("abort", cancel);
      };
      entry.onCancel = options.onCancel ?? entry.onCancel;
      if (source?.aborted) abort();
    }
    this.drain();
    return entry as WorkerTicket<T>;
  }
  /** Persist broker descriptors synchronously, without waiting for a process admission slot. */
  scheduleRemote<T>(
    name: string,
    submit: (signal: AbortSignal, admission?: TreeWorkerAdmission) => Promise<T>,
    options: { signal?: AbortSignal; onCancel?: () => void } = {},
  ): WorkerTicket<T> {
    if (!this.tree?.brokerEndpoint)
      throw new TreeAdmissionError("No root broker is available for remote worker execution.");
    return this.schedule(name, submit, { ...options, remote: true });
  }
  stop(name: string): WorkerStatus | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const status = entry.status;
    entry.controller.abort();
    return status;
  }
  setCancelHook(name: string, hook: () => void): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.onCancel = hook;
    if (entry.controller.signal.aborted) hook();
  }
  /** Buffer steering while admission or RPC startup is pending, without taking another slot. */
  message(
    name: string,
    message: string,
  ): { status: WorkerStatus; signal: AbortSignal; promise: Promise<boolean | void> } | undefined {
    const entry = this.entries.get(name);
    if (!entry || entry.status === "stopping" || entry.status === "parked") return undefined;
    const promise = new Promise<boolean | void>((resolve, reject) => {
      entry.messages.push({ message, resolve, reject });
    });
    void promise.catch(() => undefined);
    this.flushMessages(entry);
    return { status: entry.status, signal: entry.controller.signal, promise };
  }
  setSteer(name: string, steer: NonNullable<Entry["steer"]>): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    entry.steer = steer;
    this.flushMessages(entry);
  }
  private flushMessages(entry: Entry): void {
    if (!entry.steer) return;
    for (const item of entry.messages.splice(0)) {
      Promise.resolve()
        .then(() => {
          entry.controller.signal.throwIfAborted();
          return entry.steer!(item.message);
        })
        .then(item.resolve, item.reject);
    }
  }
  private cancel(entry: Entry): void {
    entry.admission?.stop(); // Persist the subtree barrier before any kill hook can race a descendant spawn.
    try {
      entry.onCancel?.();
    } catch {
      /* Cancellation must still remove queued work. */
    }
    if (entry.status === "queued") {
      this.queue = this.queue.filter((candidate) => candidate !== entry);
      entry.admission?.release();
      this.finish(entry);
      entry.reject(entry.controller.signal.reason);
      this.drain();
    } else {
      entry.admission?.release();
      entry.status = "stopping";
    }
  }
  private finish(entry: Entry): void {
    entry.detach();
    if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name);
    for (const item of entry.messages.splice(0))
      item.reject(new Error(`Subagent "${entry.name}" stopped before message delivery.`));
  }
  private drain(): void {
    try {
      this.drainReady();
    } catch (error) {
      this.closed = true;
      if (this.poll) clearTimeout(this.poll);
      this.poll = undefined;
      const failure = new TreeAdmissionError(
        `Global worker admission unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      for (const entry of [...this.entries.values()]) {
        if (entry.status === "queued") {
          this.finish(entry);
          entry.reject(failure);
        } else entry.controller.abort(failure);
      }
      this.queue = [];
    }
  }
  private drainReady(): void {
    if (this.poll) clearTimeout(this.poll);
    this.poll = undefined;
    if (this.closed) return;
    if (this.tree) {
      const statuses = new Map(this.tree.store.snapshot().map((entry) => [entry.token, entry.status]));
      for (const entry of [...this.entries.values()]) {
        const status = entry.admission && statuses.get(entry.admission.token);
        if (status && ["parking", "suspended", "waking"].includes(status)) entry.status = "parked";
        else if (status === "running" && entry.status === "parked") entry.status = "started";
        else if (entry.remote && status === "running") entry.status = "started";
        if ((status === "canceled" || status === "stopping") && !entry.controller.signal.aborted)
          entry.controller.abort();
      }
    }
    while (!this.closed && this.active < (this.tree ? Infinity : this.limit) && this.queue[0]?.run) {
      const candidate = this.queue[0];
      const status = candidate.remote ? undefined : candidate.admission?.claim();
      if (status === "queued") break;
      if (status && status !== "running") {
        this.queue.shift();
        candidate.admission?.release();
        this.finish(candidate);
        candidate.reject(new TreeAdmissionError(candidate.admission?.reason ?? `Global worker admission ${status}.`));
        continue;
      }
      const entry = this.queue.shift()!;
      entry.status = entry.remote ? "queued" : "started";
      this.active++;
      const finish = () => {
        this.active--;
        if (!this.closed && !entry.remote) entry.admission?.release();
        this.finish(entry);
        this.drain();
      };
      const execute = () => {
        entry.controller.signal.throwIfAborted();
        return entry.run!();
      };
      let pending: Promise<unknown>;
      try {
        pending = entry.remote ? execute() : Promise.resolve().then(execute);
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(
        (value) => {
          finish();
          entry.resolve(value);
        },
        (error) => {
          finish();
          entry.reject(error);
        },
      );
    }
    if (this.tree && !this.closed && this.entries.size) this.poll = setTimeout(() => this.drain(), 25);
  }
  shutdown(): void {
    this.closed = true;
    if (this.poll) clearTimeout(this.poll);
    this.poll = undefined;
    for (const entry of [...this.entries.values()]) entry.controller.abort();
  }
}
