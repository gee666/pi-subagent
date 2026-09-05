import { isResultError, type SingleResult } from "../types.js";
import { RETRY_WAIT_GRACE_MS } from "./constants.js";
import { parseRpcEvent, processRpcEvent } from "./events.js";
import { appendBoundedStderr } from "./result.js";
import type { AttemptState } from "./attempt-state.js";

interface ProtocolOptions {
  state: AttemptState;
  result: SingleResult;
  promptRequestId: string;
  emitUpdate(): void;
  noteSemanticActivity(minimumQuietPeriodMs?: number): void;
  stopChild(force: boolean): void;
  doResolve(code: number): void;
  forceStopAndSettle(code?: number): void;
}

/** Interpret run boundaries and semantic activity independently of JSONL framing. */
export function createProtocolHandler(options: ProtocolOptions): (line: string) => void {
  const { state, result, promptRequestId, emitUpdate, noteSemanticActivity, stopChild, doResolve, forceStopAndSettle } =
    options;
  return (line: string) => {
    const event = parseRpcEvent(line);
    if (!event) return;

    if (event?.type === "tool_execution_start" && typeof event.toolCallId === "string") {
      state.activeToolCallIds.add(event.toolCallId);
    } else if (event?.type === "tool_execution_end" && typeof event.toolCallId === "string") {
      state.activeToolCallIds.delete(event.toolCallId);
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
        let signature: string;
        try {
          signature = JSON.stringify(event.details);
        } catch {
          signature = "unserializable";
        }
        semanticActivity = signature !== state.lastNestedProgressSignature;
        state.lastNestedProgressSignature = signature;
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
