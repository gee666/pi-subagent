import { createHash } from "node:crypto";
import { getFinalOutput, isResultError, type SingleResult } from "../types.js";
import { isRecord } from "../types/records.js";
import { RETRY_WAIT_GRACE_MS } from "./constants.js";
import { parseRpcEvent, processRpcEvent } from "./events.js";
import { appendBoundedStderr } from "./result.js";
import type { AttemptState } from "./attempt-state.js";
import { isLeadMessageEvent } from "./lead-message.js";
import type { RunAgentOptions, RunningSubagentHandle } from "./options.js";

interface ProtocolOptions {
  state: AttemptState;
  result: SingleResult;
  promptRequestId: string;
  onLeadMessage?: RunAgentOptions["onLeadMessage"];
  onWaitingForChildren?: (waiting: boolean) => void;
  emitUpdate(): void;
  noteSemanticActivity(minimumQuietPeriodMs?: number): void;
  stopChild(force: boolean): void;
  doResolve(code: number): void;
  forceStopAndSettle(code?: number): void;
}

/** A stdin write is not delivery. Wait for prompt preflight to accept each request. */
export function createSteeringHandle(
  options: Pick<ProtocolOptions, "state" | "result" | "promptRequestId" | "noteSemanticActivity"> & {
    sendRpc(command: Record<string, unknown>): boolean;
    timeoutMs?: number;
    settleDeferred(): void;
  },
): RunningSubagentHandle {
  const { state, result, promptRequestId, sendRpc, noteSemanticActivity, settleDeferred } = options;
  const pending = (state.pendingSteeringRequests ??= new Map());
  let request = 0;
  return {
    isSettling: () => state.agentSettled || state.resolved || state.stopping === true,
    isIdle: () => state.waitingForChildren === true,
    steer(message: string): Promise<boolean> {
      if (state.agentSettled || state.resolved || state.stopping) return Promise.resolve(false);
      const id = `${promptRequestId}-steer-${++request}`;
      return new Promise<boolean>((resolve) => {
        const complete = (accepted: boolean) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          resolve(accepted);
          if (state.resolved || state.stopping) return;
          if (accepted) {
            // Preflight can answer after an older run's settlement but before
            // the new turn starts. Wait for that continuation's own settlement.
            state.pendingAgentSettled = false;
            noteSemanticActivity();
          } else if (pending.size === 0 && state.pendingAgentSettled) {
            state.pendingAgentSettled = false;
            settleDeferred();
          }
        };
        const timer = setTimeout(
          () => {
            appendBoundedStderr(result, `[pi-subagent] Steering acknowledgment timed out: ${id}\n`);
            complete(false);
          },
          Math.max(1, options.timeoutMs ?? 30_000),
        );
        pending.set(id, complete);
        // Raw steer bypasses the input hook and loses nested broadcasts.
        if (!sendRpc({ id, type: "prompt", message, streamingBehavior: "steer" })) complete(false);
      });
    },
  };
}

/** Interpret run boundaries and semantic activity independently of JSONL framing. */
export function createProtocolHandler(options: ProtocolOptions): (line: string) => void {
  const { state, result, promptRequestId, emitUpdate, noteSemanticActivity, stopChild, doResolve, forceStopAndSettle } =
    options;
  // One bounded digest per active nested call, not a retained serialized tree.
  const nestedSignatures = new Map<string, string>();
  return (line: string) => {
    if (state.resolved) return;
    const event = parseRpcEvent(line);
    if (!event) return;

    if (
      event.type === "extension_ui_request" &&
      event.method === "setStatus" &&
      event.statusKey === "pi-subagent-background"
    ) {
      if (typeof event.statusText === "string" && /^(0|[1-9]\d*)$/.test(event.statusText)) {
        const running = Number(event.statusText);
        if (Number.isSafeInteger(running)) state.backgroundJobs = running;
      }
      return;
    }
    if (event.type === "subagent_background" && Number.isSafeInteger(event.running) && Number(event.running) >= 0) {
      state.backgroundJobs = Number(event.running);
      return;
    }
    if (event.type === "turn_start") {
      result.idle = false;
      state.waitingForChildren = false;
      options.onWaitingForChildren?.(false);
      state.pendingAgentSettled = false;
    }

    if (isLeadMessageEvent(event)) {
      if (state.resolved) return;
      result.lastActionAt = Date.now();
      if (!state.agentSettled) noteSemanticActivity();
      const reportError = () => appendBoundedStderr(result, "[pi-subagent] Lead message callback failed.\n");
      try {
        // Notifications must not block stream draining, settlement, or subsequent messages.
        void Promise.resolve(options.onLeadMessage?.(event.message)).catch(reportError);
      } catch {
        reportError();
      }
      return;
    }

    if (event?.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      state.activeToolCallIds.add(event.toolCallId);
    } else if (event?.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      state.activeToolCallIds.delete(event.toolCallId);
    }

    if (event.type === "response" && event.command === "prompt" && typeof event.id === "string") {
      const complete = state.pendingSteeringRequests?.get(event.id);
      if (complete) {
        if (event.success !== true) {
          const error = typeof event.error === "string" ? event.error : "unknown RPC error";
          appendBoundedStderr(result, `[pi-subagent] Steering prompt rejected: ${error}\n`);
        }
        complete(event.success === true);
        return;
      }
    }

    if (event?.type === "response" && event.id === promptRequestId && event.command === "prompt") {
      if (event.success !== true) {
        const message = `Subagent prompt rejected: ${typeof event.error === "string" ? event.error : "unknown RPC error"}`;
        state.forcedExitCode = 1;
        result.stopReason = "error";
        result.errorMessage = message;
        appendBoundedStderr(result, `[pi-subagent] ${message}\n`);
        // No agent turn ever started, so there is no buffered semantic
        // output to drain. Kill the rejected RPC process tree and settle
        // immediately instead of waiting on slow Windows taskkill/stdio.
        stopChild(true);
        doResolve(1);
      }
      return;
    }

    // agent_end is only a low-level run boundary. Pi may now auto-retry,
    // compact-and-retry, or process a queued continuation. Killing here was
    // the direct cause of the WebSocket failures in the inspected session.
    if (event?.type === "agent_end") {
      result.lastActionAt = Date.now();
      noteSemanticActivity(event.willRetry === true ? RETRY_WAIT_GRACE_MS : 0);
      return;
    }

    if (event?.type === "agent_settled") {
      options.onWaitingForChildren?.((state.backgroundJobs ?? 0) > 0);
      if ((state.backgroundJobs ?? 0) > 0 && !result.idle) {
        result.idle = true;
        state.waitingForChildren = true;
        emitUpdate();
        const output = getFinalOutput(result.messages, result.finalOutput) || "(no output)";
        const reportError = () => appendBoundedStderr(result, "[pi-subagent] Idle notification failed.\n");
        try {
          void Promise.resolve(options.onLeadMessage?.(`Idle, waiting for children.\n${output}`)).catch(reportError);
        } catch {
          reportError();
        }
      }
      if ((state.pendingSteeringRequests?.size ?? 0) > 0) {
        // Prompt preflight may still be running in an input hook. Its response
        // determines whether this old settlement is final or a new turn follows.
        state.pendingAgentSettled = true;
        if ((state.backgroundJobs ?? 0) > 0) state.waitingForChildren = true;
        if (state.idleTimer) clearTimeout(state.idleTimer);
        state.idleTimer = undefined;
        return;
      }
      // Async descendants may wake this idle RPC session with a completion.
      // Do not reap the process tree until that continuation has settled too.
      if ((state.backgroundJobs ?? 0) > 0) {
        state.waitingForChildren = true;
        if (state.idleTimer) clearTimeout(state.idleTimer);
        state.idleTimer = undefined;
        return;
      }
      state.agentSettled = true;
      result.lastActionAt = Date.now();
      // No semantic watchdog may fire while we are only waiting for the
      // deliberately terminated RPC process tree to close. On slower
      // launchers (notably Windows taskkill), that cleanup can outlast a
      // short idle timeout and overwrite a successful settled result.
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = undefined;
      }
      if (result.stopReason === "length" && !result.errorMessage) {
        result.errorMessage = "Subagent output was incomplete because the model reached its output limit.";
      }
      const settledCode = state.forcedExitCode ?? (isResultError({ ...result, exitCode: 0 }) ? 1 : 0);
      // RPC mode remains alive waiting for more commands. Terminate its
      // process tree, but do not report completion until close (or bounded
      // SIGKILL escalation) confirms it stopped.
      forceStopAndSettle(settledCode);
      return;
    }

    const previousActionAt = result.lastActionAt;
    if (
      (event.type === "message_end" || event.type === "tool_result_end") &&
      isRecord(event.message) &&
      typeof event.message.toolCallId === "string"
    )
      nestedSignatures.delete(event.message.toolCallId);
    const accepted = processRpcEvent(event, result);
    if (accepted) {
      // Cancel the startup timer as soon as the subprocess proves it has
      // reached the LLM-call phase. Two conditions qualify:
      //   1. A turn has started (turn_start sets turnInProgress=true).
      //   2. A complete assistant turn has arrived (turns > 0).
      if (!state.receivedFirstEvent && (result.usage.turns > 0 || result.turnInProgress)) {
        state.receivedFirstEvent = true;
        if (state.startupTimer) {
          clearTimeout(state.startupTimer);
          state.startupTimer = undefined;
        }
      }
      // Parallel progress is emitted every second even when nothing changed.
      // Only a changed nested snapshot counts as activity, otherwise a dead
      // grandchild could keep every ancestor alive forever.
      let semanticActivity = true;
      if (event?.type === "subagent_progress") {
        const signature = createHash("sha256").update(JSON.stringify(event.details)).digest("hex");
        const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
        semanticActivity = signature !== nestedSignatures.get(id);
        nestedSignatures.set(id, signature);
        if (!semanticActivity) result.lastActionAt = previousActionAt;
      }
      if (semanticActivity) noteSemanticActivity();
      emitUpdate();
    } else if (state.receivedFirstEvent) {
      if (event?.type === "message_update" || event?.type === "tool_execution_update") {
        // Streaming deltas are intentionally not retained in result.messages,
        // but they prove the model/tool is still making real progress.
        result.lastActionAt = Date.now();
        noteSemanticActivity();
      } else if (event?.type === "auto_retry_start") {
        result.lastActionAt = Date.now();
        const delayMs = Number.isFinite(event.delayMs) ? Math.max(0, Number(event.delayMs)) : 0;
        noteSemanticActivity(delayMs + RETRY_WAIT_GRACE_MS);
      } else if (
        event?.type === "auto_retry_end" ||
        event?.type === "compaction_start" ||
        event?.type === "compaction_end" ||
        event?.type === "summarization_retry_scheduled" ||
        event?.type === "summarization_retry_attempt_start" ||
        event?.type === "summarization_retry_finished"
      ) {
        result.lastActionAt = Date.now();
        noteSemanticActivity();
      }
    }
  };
}
