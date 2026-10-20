import assert from "node:assert/strict";
import { createRootBroker, shutdownRootBroker } from "../../broker/root.js";
import { createTreeConcurrencyStore } from "../../storage/tree-concurrency.js";

/** Admit an in-process worker double through the same ledger real children inherit. */
export function simulatedTreeWorker(directory: string, name = "parent", limit = 50) {
  const store = createTreeConcurrencyStore({ directory, limit });
  const token = store.enqueue(name);
  assert.equal(store.claim(token), "running");
  store.bindPid(token, process.pid);
  const broker = createRootBroker(store);
  return {
    close: () => shutdownRootBroker(broker),
    store,
    token,
    env: {
      PI_SUBAGENT_CONCURRENCY_DIR: store.directory,
      PI_SUBAGENT_WORKER_TOKEN: token,
      PI_SUBAGENT_BROKER_DIR: broker.directory,
      PI_SUBAGENT_BROKER_SECRET: broker.secret,
    },
  };
}
