import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RUNTIME_PROTOCOL } from "../storage/process-registry.js";
import { isRecord } from "./contracts.js";
import { createExtensionState, type ExtensionState, type ReloadHandoff } from "./state.js";

/**
 * A Pi reload keeps the process but replaces this extension instance. Live workers stay owned by
 * the same ExtensionState object, which their callbacks already reference: the old instance parks
 * it here and the reloaded instance rebinds it to its own Pi API. The slot's top-level fields are
 * read by every release, so an incompatible newer release can still stop the old work.
 */
const SLOT = Symbol.for("pi-subagent.reload-handoff");
const ADOPTION_TIMEOUT_MS = 60_000;

interface HandoffSlot {
  protocol: unknown;
  pid: unknown;
  state: unknown;
  stop: () => Promise<void>;
}

function takeSlot(): HandoffSlot | undefined {
  const value: unknown = Reflect.get(globalThis, SLOT);
  Reflect.deleteProperty(globalThis, SLOT);
  if (!isRecord(value)) return undefined;
  const stop = value.stop;
  if (typeof stop !== "function") return undefined;
  return {
    protocol: value.protocol,
    pid: value.pid,
    state: value.state,
    stop: async () => {
      await Reflect.apply(stop, value, []);
    },
  };
}

function stopQuietly(stop: () => Promise<void>): void {
  stop().catch((error: unknown) => console.error("[pi-subagent] Failed to stop work left by a reload:", error));
}

/** Old instance: keep live work running and offer it to the reloaded instance. */
export function publishReloadHandoff(
  state: ExtensionState,
  teardown: () => Promise<void>,
  timeoutMs = ADOPTION_TIMEOUT_MS,
): void {
  // A second unclaimed reload must not orphan the first one's work.
  const previous = takeSlot();
  if (previous) stopQuietly(previous.stop);
  let stopping: Promise<void> | undefined;
  const handoff: ReloadHandoff = {
    sessionId: state.currentSessionId,
    queue: [],
    release: () => {
      clearTimeout(timer);
      process.off("exit", onExit);
    },
    stop: () =>
      (stopping ??= (async () => {
        handoff.release();
        if (state.reloadHandoff === handoff) state.reloadHandoff = undefined;
        const slot: unknown = Reflect.get(globalThis, SLOT);
        if (isRecord(slot) && slot.state === state) Reflect.deleteProperty(globalThis, SLOT);
        await teardown();
      })()),
  };
  // No adoption (failed reload, disabled or incompatible new instance) falls back to a normal shutdown.
  const timer = setTimeout(() => stopQuietly(handoff.stop), timeoutMs);
  timer.unref();
  const onExit = () => stopQuietly(handoff.stop);
  process.once("exit", onExit);
  state.reloadHandoff = handoff;
  Reflect.set(globalThis, SLOT, { protocol: RUNTIME_PROTOCOL, pid: process.pid, state, stop: handoff.stop });
}

function isHandedOffState(value: unknown): value is ExtensionState {
  return (
    isRecord(value) &&
    isRecord(value.reloadHandoff) &&
    value.backgroundJobs instanceof Map &&
    value.activeSubagents instanceof Map &&
    typeof value.lifecycleGeneration === "number"
  );
}

/** Keep live work and session identity; everything else is rebuilt as for a fresh instance. */
function rebindState(previous: ExtensionState, pi: ExtensionAPI): ExtensionState {
  const fresh = createExtensionState(pi);
  const live: Partial<ExtensionState> = {
    reloadHandoff: previous.reloadHandoff,
    backgroundJobs: previous.backgroundJobs,
    pendingCompletionDeliveries: previous.pendingCompletionDeliveries,
    pendingCompletionInterrupts: previous.pendingCompletionInterrupts,
    interruptEpoch: previous.interruptEpoch,
    lifecycleGeneration: previous.lifecycleGeneration,
    scheduledTasks: previous.scheduledTasks,
    activeSubagents: previous.activeSubagents,
    activeResumeNames: previous.activeResumeNames,
    activeSubagentUsageSummaries: previous.activeSubagentUsageSummaries,
    latestBroadcastTargets: previous.latestBroadcastTargets,
    nextActiveSubagentId: previous.nextActiveSubagentId,
    currentSessionId: previous.currentSessionId,
    currentSubagentSessionRoot: previous.currentSubagentSessionRoot,
    currentNamesFile: previous.currentNamesFile,
    currentOwnerId: previous.currentOwnerId,
    currentBudget: previous.currentBudget,
  };
  for (const key of Object.keys(previous)) Reflect.deleteProperty(previous, key);
  return Object.assign(previous, fresh, live);
}

/** New instance, at load: reuse a compatible handed-off state, or stop work it cannot drive. */
export function claimReloadHandoff(pi: ExtensionAPI): ExtensionState | undefined {
  const slot = takeSlot();
  if (!slot) return undefined;
  if (slot.protocol !== RUNTIME_PROTOCOL || slot.pid !== process.pid || !isHandedOffState(slot.state)) {
    stopQuietly(slot.stop);
    return undefined;
  }
  return rebindState(slot.state, pi);
}

/**
 * New instance, at session_start: adopt only a reload of the same session and return the buffered
 * work to replay. Synchronous, so no completion can slip between the hand-off and the new binding.
 * Any other hand-off stays on the state for the caller to stop.
 */
export function adoptReloadHandoff(
  state: ExtensionState,
  reason: string,
  sessionId: string,
): Array<() => void> | undefined {
  const handoff = state.reloadHandoff;
  if (!handoff || reason !== "reload" || sessionId !== handoff.sessionId) return undefined;
  state.reloadHandoff = undefined;
  handoff.release();
  return handoff.queue;
}
