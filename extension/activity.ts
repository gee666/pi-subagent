import { brokerActivity } from "../broker/root.js";
import { cachedBrokerEndpoint } from "./scheduler.js";
import type { ExtensionState } from "./state.js";

export interface ActivityEntry {
  name: string;
  path: string[];
  depth: number;
  startedAt: number;
  status: "running" | "idle";
  topLevelId: number;
}

interface ActivityCache {
  generation: number;
  targets: unknown;
  activeCount: number;
  brokerKey: string;
  at: number;
  firstSeen: Map<string, number>;
  entries: ActivityEntry[];
}
const caches = new WeakMap<ExtensionState, ActivityCache>();

/** Only live handles and their latest snapshots. Never read session files on a UI tick. */
export function getActivitySnapshot(state: ExtensionState, now = Date.now()): ActivityEntry[] {
  const previous = caches.get(state);
  const targets = state.latestBroadcastTargets.all;
  const endpoint = cachedBrokerEndpoint(state);
  const broker = endpoint ? brokerActivity(endpoint) : [];
  const brokerKey = JSON.stringify(broker);
  if (
    previous?.generation === state.lifecycleGeneration &&
    previous.targets === targets &&
    previous.activeCount === state.activeSubagents.size &&
    previous.brokerKey === brokerKey &&
    now - previous.at < 250
  )
    return previous.entries;
  const firstSeen = new Map<string, number>();
  const entries = new Map<string, ActivityEntry>();
  const add = (path: string[], topLevelId: number, startedAt?: number, idle = false) => {
    const name = path.at(-1) || "worker";
    const key = name;
    const start =
      startedAt ??
      (previous?.generation === state.lifecycleGeneration ? previous.firstSeen.get(key) : undefined) ??
      now;
    firstSeen.set(key, start);
    entries.set(key, {
      name,
      path,
      depth: path.length - 1,
      topLevelId,
      startedAt: start,
      status: idle ? "idle" : "running",
    });
  };
  const roots = new Map(
    targets.filter((target) => target.restPath.length === 0).map((target) => [target.topLevelId, target]),
  );
  const brokerNames = new Set(broker.map((worker) => worker.name));
  for (const target of targets) {
    if (!state.activeSubagents.has(target.topLevelId) || target.restPath.length === 0) continue;
    const path = target.display.split(" > ");
    // With a root broker, only its live handles prove a descendant is running.
    if (endpoint && !brokerNames.has(path.at(-1)!)) continue;
    add(path, target.topLevelId, target.startedAt, target.idle);
  }
  for (const [id, active] of state.activeSubagents) {
    const target = roots.get(id);
    add(
      [active.name || active.agent || "worker"],
      id,
      active.startedAt ?? target?.startedAt,
      active.handle.isIdle?.() ?? target?.idle ?? false,
    );
  }
  const topLevelIds = new Map(
    [...entries.values()].filter((entry) => entry.depth === 0).map((entry) => [entry.name, entry.topLevelId]),
  );
  for (const worker of broker) {
    const path = worker.path.length ? worker.path : [worker.name];
    const id = topLevelIds.get(path[0]) ?? entries.get(worker.name)?.topLevelId ?? -1;
    add(path, id, worker.startedAt, worker.idle);
  }
  const sorted = [...entries.values()].sort(
    (a, b) => a.depth - b.depth || a.topLevelId - b.topLevelId || a.name.localeCompare(b.name),
  );
  caches.set(state, {
    generation: state.lifecycleGeneration,
    targets,
    activeCount: state.activeSubagents.size,
    brokerKey,
    at: now,
    firstSeen,
    entries: sorted,
  });
  return sorted;
}
