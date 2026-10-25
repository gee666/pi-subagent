import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { persistWorkerStops } from "../storage/worker-stops.js";
import { releaseCompletionDelivery } from "./async-jobs.js";
import { cachedSchedulerFor } from "./scheduler.js";
import { clearSyntheticResumeState, restoreModelAfterResumeFailure } from "./runtime.js";
import { stopBranches } from "./stop-tool.js";
import type { ExtensionState } from "./state.js";

/** Escape must reach detached workers even when the main agent has no active turn. */
export function registerSubagentInterrupt(state: ExtensionState): void {
  let unsubscribe = () => {};
  let startingResumeEpoch: number | undefined;
  state.onSessionReadyForInterrupt = (ctx) => {
    startingResumeEpoch = undefined;
    unsubscribe();
    unsubscribe = () => {};
    if (ctx.mode !== "tui" || !ctx.hasUI || state.currentDepth !== 0) return;
    const generation = state.lifecycleGeneration;
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (
        !state.sessionActive ||
        state.lifecycleGeneration !== generation ||
        isKeyRelease(data) ||
        !matchesKey(data, "escape")
      )
        return;
      // Also cancel an outstanding resume confirmation, even before plans are armed.
      state.interruptEpoch = (state.interruptEpoch ?? 0) + 1;
      const context = state.latestSessionCtx ?? ctx;
      const scheduler = cachedSchedulerFor(state);
      const deliveries = [...state.pendingCompletionDeliveries.keys()];
      const names = new Set<string>();
      let hasWork = !!(
        state.backgroundJobs.size ||
        state.activeSubagents.size ||
        deliveries.length ||
        state.pendingResumePlans.length ||
        state.pendingInteractiveResumePrompt ||
        state.pendingAutomaticResume
      );
      const errors: string[] = [];
      const attempt = (operation: () => void) => {
        try {
          operation();
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      };
      // Gather local work before reading the ledger, so a disk error cannot hide local handles.
      for (const entry of scheduler?.snapshot() ?? []) names.add(entry.name);
      for (const worker of state.activeSubagents.values()) if (worker.name) names.add(worker.name);
      for (const job of state.backgroundJobs.values()) for (const name of job.names) names.add(name);
      for (const plan of state.pendingResumePlans)
        for (const result of plan.details?.results ?? []) if (result.name) names.add(result.name);
      attempt(() => {
        // Include broker-owned descendants and parked parents, not just local handles.
        for (const entry of scheduler?.treeStore?.snapshot() ?? []) {
          if (["queued", "running", "parking", "suspended", "waking", "stopping"].includes(entry.status))
            names.add(entry.name);
        }
      });
      hasWork ||= names.size > 0;
      if (!hasWork && !errors.length) return;
      try {
        state.pendingInteractiveResumePrompt = null;
        state.pendingResumePlans = [];
        clearSyntheticResumeState(state);
        attempt(() => {
          if (!names.size) return;
          const stopped = stopBranches(state, [...names]);
          errors.push(...stopped.statuses.flatMap((status) => (status.error ? [status.error] : [])));
          // Synchronous markers precede completion microtasks and automatic recovery.
          persistWorkerStops(state.currentNamesFile, stopped.stoppedNames);
        });
        // Fallbacks are independent: a failed kill or ledger write must not skip other workers.
        if (errors.length) {
          for (const worker of state.activeSubagents.values()) attempt(() => worker.handle.kill?.());
          for (const job of state.backgroundJobs.values()) attempt(() => job.controller.abort());
        } else {
          for (const worker of state.activeSubagents.values()) if (!worker.name) attempt(() => worker.handle.kill?.());
        }
      } finally {
        // Abort first, clearing Pi's queued steering before replaying accounting without a turn.
        attempt(() => context.abort());
        for (const id of deliveries) {
          attempt(() => state.pendingCompletionInterrupts?.get(id)?.());
          releaseCompletionDelivery(state, id, generation);
        }
        void restoreModelAfterResumeFailure(state, context);
        if (errors.length) context.ui.notify(`Failed to stop some subagent work: ${errors.join("; ")}`, "error");
      }
      // Preserve native Escape handling for dialogs, compaction, and the main editor.
      return undefined;
    });
  };
  state.pi.on("input", (event) => {
    const pending = state.pendingAutomaticResume;
    if (
      event.source === "extension" &&
      event.text === pending?.prompt &&
      pending.interruptEpoch !== (state.interruptEpoch ?? 0)
    ) {
      state.pendingAutomaticResume = undefined;
      return { action: "handled" as const };
    }
  });
  state.pi.on("before_agent_start", (event) => {
    const pending = state.pendingAutomaticResume;
    startingResumeEpoch =
      event.messageType === "user" && pending && event.prompt === pending.prompt ? pending.interruptEpoch : undefined;
    if (startingResumeEpoch !== undefined) state.pendingAutomaticResume = undefined;
  });
  state.pi.on("agent_start", (_event, ctx) => {
    const epoch = startingResumeEpoch;
    startingResumeEpoch = undefined;
    // Pi can await prompt preflight after submission. Abort at loop entry if Escape
    // canceled that automatic prompt while it was outside the active agent loop.
    if (epoch !== undefined && epoch !== (state.interruptEpoch ?? 0)) ctx.abort();
  });
  state.pi.on("session_shutdown", () => {
    startingResumeEpoch = undefined;
    state.pendingAutomaticResume = undefined;
    unsubscribe();
    unsubscribe = () => {};
  });
}
