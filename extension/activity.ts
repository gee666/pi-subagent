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
  at: number;
  firstSeen: Map<string, number>;
  entries: ActivityEntry[];
}
const caches = new WeakMap<ExtensionState, ActivityCache>();

/** Only live handles and their latest snapshots. Never read session files on a UI tick. */
export function getActivitySnapshot(state: ExtensionState, now = Date.now()): ActivityEntry[] {
  const previous = caches.get(state);
  const targets = state.latestBroadcastTargets.all;
  if (
    previous?.generation === state.lifecycleGeneration &&
    previous.targets === targets &&
    previous.activeCount === state.activeSubagents.size &&
    now - previous.at < 250
  )
    return previous.entries;
  const firstSeen = new Map<string, number>();
  const entries = new Map<string, ActivityEntry>();
  const add = (path: string[], topLevelId: number, startedAt?: number, idle = false) => {
    const name = path.at(-1) || "worker";
    const key = `${topLevelId}:${name}`;
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
  for (const target of targets) {
    if (!state.activeSubagents.has(target.topLevelId) || target.restPath.length === 0) continue;
    add(target.display.split(" > "), target.topLevelId, target.startedAt, target.idle);
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
  const sorted = [...entries.values()].sort(
    (a, b) => a.depth - b.depth || a.topLevelId - b.topLevelId || a.name.localeCompare(b.name),
  );
  caches.set(state, {
    generation: state.lifecycleGeneration,
    targets,
    activeCount: state.activeSubagents.size,
    at: now,
    firstSeen,
    entries: sorted,
  });
  return sorted;
}
