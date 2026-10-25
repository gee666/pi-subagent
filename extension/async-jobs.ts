import { randomUUID } from "node:crypto";
import { SUBAGENT_COMPLETION_TYPE, SUBAGENT_MESSAGE_TYPE } from "../types.js";
import type { ProgressUpdate } from "./contracts.js";
import type { ExtensionState } from "./state.js";
import { updateCombinedUsageStatus } from "./runtime.js";
import { ackBrokerJob } from "../broker/files.js";
import { inheritedBrokerEndpoint, BROKER_CONSUMED_ENTRY } from "./broker-jobs.js";

export interface BackgroundJob {
  names: string[];
  controller: AbortController;
  promise: Promise<void>;
}

// Session teardown may clear the map directly. Size/generation changes invalidate
// this count; normal reservations and acknowledgments update it in constant time.
const deliveryCounts = new WeakMap<object, { generation: number; size: number; count: number }>();
function pendingCount(state: ExtensionState): number {
  const map = (state.pendingCompletionDeliveries ??= new Map());
  const cached = deliveryCounts.get(map);
  if (cached?.generation === state.lifecycleGeneration && cached.size === map.size) return cached.count;
  let count = 0;
  for (const generation of map.values()) if (generation === state.lifecycleGeneration) count++;
  deliveryCounts.set(map, { generation: state.lifecycleGeneration, size: map.size, count });
  return count;
}
function recordCount(state: ExtensionState, count: number): void {
  deliveryCounts.set(state.pendingCompletionDeliveries, {
    generation: state.lifecycleGeneration,
    size: state.pendingCompletionDeliveries.size,
    count,
  });
}

/** Pending delivery is work too: a queued message has not started its continuation yet. */
function emitBackgroundCount(state: ExtensionState): void {
  if (state.currentDepth > 0) {
    const running = state.backgroundJobs.size + pendingCount(state);
    if (state.latestSessionCtx?.mode === "rpc") {
      // RPC redirects ordinary stdout to stderr. Public status events share
      // the ordered RPC output queue with agent_settled, without persistence.
      state.latestSessionCtx.ui.setStatus("pi-subagent-background", String(running));
      return;
    }
    process.stdout.write(`${JSON.stringify({ type: "subagent_background", running })}\n`);
  }
}

/** Reserve before scheduling, so job settlement cannot expose a false idle window. */
export function retainCompletionDelivery(state: ExtensionState, generation: number): string {
  const token = randomUUID();
  const count = pendingCount(state);
  state.pendingCompletionDeliveries.set(token, generation);
  recordCount(state, count + Number(generation === state.lifecycleGeneration));
  emitBackgroundCount(state);
  return token;
}

export function releaseCompletionDelivery(state: ExtensionState, token: string, generation: number): void {
  if (generation !== state.lifecycleGeneration || state.pendingCompletionDeliveries?.get(token) !== generation) return;
  const count = pendingCount(state);
  state.pendingCompletionDeliveries.delete(token);
  state.pendingCompletionInterrupts?.delete(token);
  recordCount(state, count - 1);
  emitBackgroundCount(state);
}

/** Register once from registerSessionEvents. Starting an unrelated run must not drain this counter. */
export function registerAsyncDeliveryEvents(state: ExtensionState): void {
  state.pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) =>
        !(
          message.role === "custom" &&
          message.customType === SUBAGENT_COMPLETION_TYPE &&
          message.details &&
          typeof message.details === "object" &&
          "silentStopped" in message.details &&
          message.details.silentStopped === true
        ),
    );
    if (messages.length !== event.messages.length) return { messages };
  });
  state.pi.on("message_start", (event) => {
    const message = event.message;
    if (!state.sessionActive || message.role !== "custom" || message.customType !== SUBAGENT_COMPLETION_TYPE) return;
    const details: unknown = message.details;
    if (!details || typeof details !== "object" || !("asyncDeliveryId" in details)) return;
    if ("brokerJobId" in details && typeof details.brokerJobId === "string") {
      // Persist the dedupe marker before acknowledging the root's durable mailbox.
      state.pi.appendEntry(BROKER_CONSUMED_ENTRY, { id: details.brokerJobId });
      const endpoint = inheritedBrokerEndpoint();
      if (endpoint) ackBrokerJob(endpoint, details.brokerJobId);
    }
    if (typeof details.asyncDeliveryId !== "string") return;
    // Pi emits message_start on consumption, after turn_start, for both an idle
    // prompt and a steering message drained within an already-running agent.
    releaseCompletionDelivery(state, details.asyncDeliveryId, state.lifecycleGeneration);
  });
}

export function notifyLead(
  state: ExtensionState,
  content: string,
  generation = state.lifecycleGeneration,
  interruptEpoch = state.interruptEpoch ?? 0,
): void {
  if (
    !state.sessionActive ||
    state.lifecycleGeneration !== generation ||
    (state.interruptEpoch ?? 0) !== interruptEpoch
  )
    return;
  // Custom messages use Pi\'s distinct customMessageBg instead of userMessageBg.
  state.pi.sendMessage(
    { customType: SUBAGENT_MESSAGE_TYPE, content, display: true, details: undefined },
    {
      deliverAs: "steer",
      triggerTurn: true,
    },
  );
}

export function startBackground(
  state: ExtensionState,
  key: string,
  names: string[],
  run: (signal: AbortSignal) => Promise<ProgressUpdate>,
  cleanup?: () => Promise<void>,
): void {
  const generation = state.lifecycleGeneration;
  const interruptEpoch = state.interruptEpoch ?? 0;
  const controller = new AbortController();
  const job: BackgroundJob = { names, controller, promise: Promise.resolve() };
  state.backgroundJobs.set(key, job);
  emitBackgroundCount(state);
  // Admission is synchronous so queued workers are visible before the tool receipt.
  // Subprocess execution itself remains deferred by the scheduler.
  let execution: Promise<ProgressUpdate>;
  try {
    execution = run(controller.signal);
  } catch (error) {
    execution = Promise.reject(error);
  }
  job.promise = execution
    .then(() => undefined)
    .catch((error) => {
      notifyLead(
        state,
        `Subagent job ${names.join(", ") || key} failed: ${error instanceof Error ? error.message : String(error)}`,
        generation,
        interruptEpoch,
      );
    })
    .finally(async () => {
      try {
        await cleanup?.();
      } catch (error) {
        console.error("[pi-subagent] Background cleanup failed:", error);
      }
      if (state.backgroundJobs.get(key) !== job) return;
      state.backgroundJobs.delete(key);
      if (generation !== state.lifecycleGeneration) return;
      state.activeSubagentUsageSummaries.delete(key);
      emitBackgroundCount(state);
      updateCombinedUsageStatus(state);
    });
}

export async function stopBackgroundJobs(state: ExtensionState): Promise<void> {
  const generation = state.lifecycleGeneration;
  const jobs = Array.from(state.backgroundJobs.entries());
  for (const [, job] of jobs) job.controller.abort();
  await Promise.allSettled(jobs.map(([, job]) => job.promise));
  // A replacement with the same key belongs to its new caller, not this drain.
  for (const [key, job] of jobs) {
    if (state.backgroundJobs.get(key) === job) state.backgroundJobs.delete(key);
  }
  if (generation === state.lifecycleGeneration) emitBackgroundCount(state);
}
