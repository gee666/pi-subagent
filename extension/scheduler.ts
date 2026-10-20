import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { configuredEnv } from "../settings.js";
import { DEFAULT_MAX_CONCURRENCY, parseNonNegativeInt, SUBAGENT_MAX_CONCURRENCY_ENV } from "../shared.js";
import { WorkerScheduler } from "../runner/worker-scheduler.js";
import { CONCURRENCY_DIR_ENV, WORKER_TOKEN_ENV } from "../runner/tree-admission.js";
import {
  createTreeConcurrencyStore,
  openTreeConcurrencyStore,
  type TreeConcurrencyStore,
} from "../storage/tree-concurrency.js";
import type { ExtensionState } from "./state.js";
import { BROKER_DIR_ENV, BROKER_SECRET_ENV } from "../broker/contracts.js";
import { createRootBroker, shutdownRootBroker } from "../broker/root.js";

export { WorkerScheduler } from "../runner/worker-scheduler.js";
export type { WorkerStatus, WorkerTicket } from "../runner/worker-scheduler.js";
const schedulers = new WeakMap<ExtensionState, WorkerScheduler>();

/** Descendants inherit the root ledger. Their personal concurrency settings cannot change its cap. */
export function schedulerFor(state: ExtensionState): WorkerScheduler {
  const limit =
    parseNonNegativeInt(configuredEnv(SUBAGENT_MAX_CONCURRENCY_ENV, state.settings)) ?? DEFAULT_MAX_CONCURRENCY;
  const inheritedDirectory = process.env[CONCURRENCY_DIR_ENV];
  const parentToken = process.env[WORKER_TOKEN_ENV];
  if (!!inheritedDirectory !== !!parentToken || (state.currentDepth > 0 && (!inheritedDirectory || !parentToken)))
    throw new Error(
      "Nested worker is missing global concurrency admission metadata. Restart it through the parent main session; no workers were spawned.",
    );
  const inherited = state.currentDepth > 0;
  const brokerDirectory = process.env[BROKER_DIR_ENV],
    brokerSecret = process.env[BROKER_SECRET_ENV];
  if (!!brokerDirectory !== !!brokerSecret || (inherited && (!brokerDirectory || !brokerSecret)))
    throw new Error("Nested worker is missing its root execution broker. Restart it through the parent main session.");
  let scheduler = schedulers.get(state);
  if (!scheduler) {
    const store = inherited
      ? openTreeConcurrencyStore(inheritedDirectory!)
      : createTreeConcurrencyStore({
          directory: path.join(
            state.currentSubagentSessionRoot || path.resolve("tmp", "pi-subagent-sessions"),
            ".concurrency",
            encodeURIComponent(state.currentSessionId),
            `${state.lifecycleGeneration}-${randomUUID()}`,
          ),
          limit: Math.max(1, limit),
        });
    scheduler = new WorkerScheduler(limit, {
      store,
      parentToken: inherited ? parentToken : undefined,
      root: !inherited,
      brokerEndpoint: inherited ? { directory: brokerDirectory!, secret: brokerSecret! } : createRootBroker(store),
    });
    schedulers.set(state, scheduler);
  } else if (!inherited && scheduler.concurrency !== Math.max(1, limit)) scheduler.setLimit(limit);
  return scheduler;
}

/** UI reads must not initialize schedulers or touch the filesystem. */
export function cachedBrokerEndpoint(state: ExtensionState) {
  return schedulers.get(state)?.brokerEndpoint;
}

export function treeStoreFor(state: ExtensionState): TreeConcurrencyStore {
  return schedulerFor(state).treeStore!;
}

/** Old admission tokens cannot be reused after a session lifecycle change. */
export async function shutdownScheduler(state: ExtensionState): Promise<void> {
  const scheduler = schedulers.get(state);
  scheduler?.shutdown();
  schedulers.delete(state);
  if (state.currentDepth === 0 && scheduler?.brokerEndpoint) await shutdownRootBroker(scheduler.brokerEndpoint);
}
