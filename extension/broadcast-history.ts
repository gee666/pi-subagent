import { getNestedSubagentResults, isSubagentToolName, type SingleResult, type SubagentDetails } from "../types.js";
import type { TranscriptMessage } from "../types/transcript.js";
import type { BroadcastTarget } from "./broadcast.js";
import type { ExtensionState } from "./state.js";

const histories = new WeakMap<
  TranscriptMessage[],
  {
    length: number;
    last: unknown;
    relevant: TranscriptMessage[];
    nested: ReturnType<typeof getNestedSubagentResults>;
  }
>();

/** Ignore assistant/token history when updating live descendant routing. */
export function nestedBroadcastHistory(messages: TranscriptMessage[] | undefined) {
  // Compact refs and serialized progress deliberately omit transcripts.
  if (!Array.isArray(messages)) return [];
  let cache = histories.get(messages);
  if (!cache || cache.length > messages.length || (cache.length && cache.last !== messages[cache.length - 1])) {
    cache = { length: 0, last: undefined, relevant: [], nested: [] };
    histories.set(messages, cache);
  }
  const before = cache.relevant.length;
  for (let i = cache.length; i < messages.length; i++) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    if (
      (message.role === "toolResult" && isSubagentToolName(message.toolName)) ||
      (message.role === "custom" && Reflect.get(message, "customType") === "subagent_completion")
    )
      cache.relevant.push(message);
  }
  cache.length = messages.length;
  cache.last = messages[messages.length - 1];
  if (before !== cache.relevant.length) cache.nested = getNestedSubagentResults(cache.relevant);
  return cache.nested;
}

type Targets = ExtensionState["latestBroadcastTargets"];
type Active = ExtensionState["activeSubagents"] extends Map<number, infer T> ? T : never;
interface RootTargets extends Targets {
  id: number;
  handle: Active["handle"];
  name: string;
  fallback?: boolean;
}
interface TargetCache {
  generation: number;
  source: Targets;
  // Removed handles release unread snapshots too, including in headless sessions.
  roots: WeakMap<Active, RootTargets>;
  observed: Map<number, RootTargets>;
  flat?: Targets;
}
const targetCaches = new WeakMap<ExtensionState, TargetCache>();

function resetGeneration(state: ExtensionState, cache: TargetCache): void {
  if (cache.generation === state.lifecycleGeneration) return;
  cache.generation = state.lifecycleGeneration;
  cache.roots = new WeakMap();
  cache.observed.clear();
  cache.flat = undefined;
}

function rootTargets(owner: Active, id: number, targets: Targets, fallback = false): RootTargets {
  return { id, handle: owner.handle, name: owner.name || owner.agent, ...targets, fallback };
}

function importTargets(
  state: ExtensionState,
  cache: TargetCache,
  key: keyof Targets,
  targets: BroadcastTarget[],
): void {
  for (const target of targets) {
    const owner = state.activeSubagents.get(target.topLevelId);
    if (!owner) continue;
    let root = cache.roots.get(owner);
    if (
      !root ||
      root.id !== target.topLevelId ||
      root.handle !== owner.handle ||
      root.name !== (owner.name || owner.agent)
    ) {
      root = rootTargets(owner, target.topLevelId, { all: [], youngest: [] });
      cache.roots.set(owner, root);
    }
    root[key].push(target);
  }
}

/** Assignments replace one public list without reviving older per-root snapshots. */
function replaceTargets(
  state: ExtensionState,
  cache: TargetCache,
  key: keyof Targets,
  targets: BroadcastTarget[],
): void {
  resetGeneration(state, cache);
  for (const owner of state.activeSubagents.values()) {
    const root = cache.roots.get(owner);
    if (!root) continue;
    root[key] = [];
    root.fallback = false;
  }
  importTargets(state, cache, key, targets);
  cache.flat = undefined;
}

function getTargetCache(state: ExtensionState): TargetCache {
  let cache = targetCaches.get(state);
  if (!cache || cache.source !== state.latestBroadcastTargets) {
    const source = state.latestBroadcastTargets;
    const { all, youngest } = source;
    cache = { generation: state.lifecycleGeneration, source, roots: new WeakMap(), observed: new Map() };
    targetCaches.set(state, cache);
    importTargets(state, cache, "all", all);
    importTargets(state, cache, "youngest", youngest);
    const current = cache;
    for (const key of ["all", "youngest"] as const) {
      Object.defineProperty(source, key, {
        enumerable: true,
        configurable: true,
        get: () => readTargets(state, current)[key],
        set: (targets: BroadcastTarget[]) => replaceTargets(state, current, key, targets),
      });
    }
  }
  resetGeneration(state, cache);
  return cache;
}

/** Reconcile on reads, not on every job's progress. Map size alone misses replacements. */
function readTargets(state: ExtensionState, cache: TargetCache): Targets {
  resetGeneration(state, cache);
  const observed = new Map<number, RootTargets>();
  for (const [id, owner] of state.activeSubagents) {
    let root = cache.roots.get(owner);
    if (root && (root.id !== id || root.handle !== owner.handle || root.name !== (owner.name || owner.agent)))
      root = undefined;
    if (!root || root.fallback) {
      const old = root?.all[0];
      const idle = owner.handle.isIdle?.() === true;
      if (!old || old.startedAt !== owner.startedAt || Boolean(old.idle) !== idle) {
        const target: BroadcastTarget = {
          display: owner.name || owner.agent,
          topLevelId: id,
          restPath: [],
          ...(owner.startedAt !== undefined ? { startedAt: owner.startedAt } : {}),
          ...(idle ? { idle: true } : {}),
        };
        root = rootTargets(owner, id, { all: [target], youngest: [target] }, true);
        cache.roots.set(owner, root);
      }
    }
    observed.set(id, root!);
    if (cache.observed.get(id) !== root) cache.flat = undefined;
  }
  if (cache.observed.size !== observed.size) cache.flat = undefined;
  cache.observed = observed;
  if (!cache.flat) {
    const all = new Map<string, BroadcastTarget>();
    const youngest = new Map<string, BroadcastTarget>();
    for (const root of observed.values()) {
      for (const target of root.all) all.set(target.display, target);
      for (const target of root.youngest) youngest.set(target.display, target);
    }
    const sorted = (targets: Map<string, BroadcastTarget>) =>
      [...targets.values()].sort((a, b) => a.display.localeCompare(b.display));
    cache.flat = { all: sorted(all), youngest: sorted(youngest) };
  }
  return cache.flat;
}

/** A progress update visits only its own roots. Flattening and fallback discovery are lazy. */
export function updateBroadcastTargetCache(
  state: ExtensionState,
  details: SubagentDetails | undefined,
  topLevelBaseId: number,
  collect: (result: SingleResult, path: string[], id: number, targets: Targets) => boolean,
): void {
  const cache = getTargetCache(state);
  details?.results.forEach((result, index) => {
    const id = topLevelBaseId + index;
    const owner = state.activeSubagents.get(id);
    if (!owner) return;
    const targets: Targets = { all: [], youngest: [] };
    collect(result, [result.name || result.agent], id, targets);
    cache.roots.set(owner, rootTargets(owner, id, targets));
  });
  cache.flat = undefined;
}
