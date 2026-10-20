import { readNamesRegistry, type SubagentNameRecord } from "../names.js";
import { WORKER_TOKEN_ENV } from "../storage/tree-concurrency.js";
import { schedulerFor } from "./scheduler.js";
import type { ExtensionState } from "./state.js";

/** A caller may address its children, not grandchildren, siblings or another owner's saved workers. */
export function assertDirectChild(state: ExtensionState, name: string): SubagentNameRecord | undefined {
  const agents = state.currentNamesFile ? readNamesRegistry(state.currentNamesFile).agents : {};
  const record = Object.hasOwn(agents, name) ? agents[name] : undefined;
  if (record && record.ownerSessionId !== state.currentOwnerId) {
    throw new Error(
      `Cannot address subagent "${name}": only your own direct children may be messaged or stopped. Ask its parent agent instead.`,
    );
  }
  const parentToken = state.currentDepth > 0 ? process.env[WORKER_TOKEN_ENV] : undefined;
  const entries =
    schedulerFor(state)
      .treeStore?.snapshot()
      .filter((entry) => entry.name === name) ?? [];
  if (entries.length && !entries.some((entry) => entry.parentToken === parentToken)) {
    throw new Error(`Cannot address subagent "${name}": it is not your direct child. Ask its parent agent instead.`);
  }
  return record;
}

export function assertChildCanReceiveMessage(state: ExtensionState, name: string): void {
  assertDirectChild(state, name);
  const entries =
    schedulerFor(state)
      .treeStore?.snapshot()
      .filter((entry) => entry.name === name) ?? [];
  if (entries.some((entry) => ["parking", "suspended", "waking"].includes(entry.status))) {
    throw new Error(
      `Cannot message subagent "${name}": it is suspended while its children run. Wait until it has resumed.`,
    );
  }
}
