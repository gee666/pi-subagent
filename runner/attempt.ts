import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { parseLeadMessageStderrLine } from "./lead-message.js";
import { JsonlFramer } from "./jsonl-framer.js";
import { isResultError, type SingleResult } from "../types.js";
import { attemptEnvironment } from "./attempt-env.js";
import { AttemptParking } from "./attempt-parking.js";
import {
  configuredNonNegativeInt,
  SIGKILL_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  SUBAGENT_STARTUP_TIMEOUT_ENV,
  DEFAULT_IDLE_TIMEOUT_MS,
  SUBAGENT_IDLE_TIMEOUT_ENV,
  MAX_CAPTURED_STDERR_CHARS,
} from "./constants.js";
import { getPiSpawnCommand, stopProcessTree, killProcessTreeImmediately } from "./launch.js";
import { appendBoundedStderr } from "./result.js";
import { isProgressOnlyEvent } from "./events.js";
import { createProtocolHandler, createSteeringHandle } from "./protocol.js";
import type { AttemptState } from "./attempt-state.js";
import type { RunAgentOptions } from "./options.js";

/** Spawn, supervise, and drain one child. Startup retry policy belongs to single.ts. */
export async function runAttempt(
  opts: RunAgentOptions,
  result: SingleResult,
  piArgs: string[],
  prompt: string,
  attempt: number,
  emitUpdate: () => void,
): Promise<{ exitCode: number; startupTimedOut: boolean; wasAborted: boolean; parked?: boolean }> {
  const { piCommandOverride, startupTimeoutMsOverride, idleTimeoutMsOverride, terminationTimeoutMsOverride, signal } =
    opts;
  const state: AttemptState = {
    resolved: false,
    receivedFirstEvent: false,
    agentSettled: false,
    startupTimedOut: false,
    wasAborted: false,
    activeToolCallIds: new Set(),
    pendingSteeringRequests: new Map(),
  };
  try {
    if (opts.treeAdmission) await opts.treeAdmission.ensure(signal);
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) return { exitCode: 130, startupTimedOut: false, wasAborted: true };
    throw error;
  }
  if (result.parked) {
    result.parked = false;
    result.idle = false;
    emitUpdate();
  }
  let parked = false;
  const exitCode = await new Promise<number>((resolve) => {
    // Use node + CLI directly on Windows; shell:true corrupts spaced arguments.
    const piSpawn = getPiSpawnCommand(piCommandOverride, opts.settings);
    const proc = spawn(piSpawn.command, [...piSpawn.argsPrefix, ...piArgs], {
      cwd: opts.cwd,
      shell: false,
      // A separate POSIX process group lets timeout/cancel terminate nested
      // agents and tools, rather than only their immediate Pi parent.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: attemptEnvironment(opts, result),
    });

    let abortHandler: (() => void) | undefined;
    const promptRequestId = `pi-subagent-${process.pid}-${Date.now()}-${attempt}`;

    const sendRpc = (command: Record<string, unknown>): boolean => {
      try {
        if (!proc.stdin?.writable) return false;
        proc.stdin.write(`${JSON.stringify(command)}\n`);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        appendBoundedStderr(result, `[pi-subagent] RPC stdin write failed: ${message}\n`);
        return false;
      }
    };

    const failPendingSteering = () => {
      for (const complete of state.pendingSteeringRequests!.values()) complete(false);
    };

    const startupTimeoutMs =
      startupTimeoutMsOverride ??
      configuredNonNegativeInt(SUBAGENT_STARTUP_TIMEOUT_ENV, DEFAULT_STARTUP_TIMEOUT_MS, false, opts.settings);

    const doResolve = (code: number) => {
      if (state.resolved || (parking.requested && !parking.exited)) return;
      parking.dispose();
      state.resolved = true;
      failPendingSteering();
      if (state.startupTimer) {
        clearTimeout(state.startupTimer);
        state.startupTimer = undefined;
      }
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = undefined;
      }
      if (state.killTimer) {
        clearTimeout(state.killTimer);
        state.killTimer = undefined;
      }
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      // Rejection/spawn-error paths can settle before close. Stop draining and
      // release stream buffers there too; normal close has already been flushed.
      proc.stdin?.destroy();
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      resolve(code);
    };

    const stopChild = (force: boolean) => stopProcessTree(proc, force);
    const forceStopAndSettle = (settleCode = state.forcedExitCode ?? 1, immediately = false) => {
      state.stopping = true;
      failPendingSteering();
      if (immediately) killProcessTreeImmediately(proc);
      else stopChild(false);
      if (state.killTimer) clearTimeout(state.killTimer);
      state.killTimer = setTimeout(() => {
        if (state.resolved) return;
        stopChild(true);
        // Never depend exclusively on a close event from a wedged child.
        proc.stdin?.destroy();
        proc.stdout?.destroy();
        proc.stderr?.destroy();
        proc.unref();
        doResolve(settleCode);
      }, terminationTimeoutMsOverride ?? SIGKILL_TIMEOUT_MS);
    };

    const idleTimeoutMs =
      idleTimeoutMsOverride !== undefined
        ? Math.max(0, idleTimeoutMsOverride)
        : configuredNonNegativeInt(SUBAGENT_IDLE_TIMEOUT_ENV, DEFAULT_IDLE_TIMEOUT_MS, false, opts.settings);

    const noteSemanticActivity = (minimumQuietPeriodMs = 0) => {
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = undefined;
      }
      if (!state.receivedFirstEvent || idleTimeoutMs === 0 || state.resolved || state.waitingForChildren) return;
      // The idle timeout measures the agent itself, not tools it has invoked.
      // A tool may legitimately be silent for longer than the configured
      // timeout, so leave the watchdog disarmed until every concurrent tool
      // execution has ended. tool_execution_end will call this again and
      // start a fresh full inactivity window.
      if (state.activeToolCallIds.size > 0) return;
      const quietPeriodMs = Math.max(idleTimeoutMs, minimumQuietPeriodMs);
      state.idleTimer = setTimeout(() => {
        if (state.resolved) return;
        const message = `Subagent inactivity timeout: no agent activity for ${quietPeriodMs}ms.`;
        state.forcedExitCode = 1;
        result.stopReason = "error";
        result.errorMessage = message;
        appendBoundedStderr(result, `\n[pi-subagent] Killed: ${message}`);
        emitUpdate();
        forceStopAndSettle();
      }, quietPeriodMs);
    };

    const parking = new AttemptParking(opts, state, proc, result);
    const flushLine = createProtocolHandler({
      state,
      result,
      promptRequestId,
      onLeadMessage: opts.onLeadMessage,
      onWaitingForChildren: (waiting) => parking.waiting(waiting, () => forceStopAndSettle(1, true)),
      emitUpdate,
      noteSemanticActivity,
      stopChild,
      doResolve,
      forceStopAndSettle,
    });

    if (startupTimeoutMs > 0) {
      state.startupTimer = setTimeout(() => {
        if (state.resolved || state.receivedFirstEvent) return;
        state.startupTimedOut = true;
        const message = `Subagent startup timeout: no model turn after ${startupTimeoutMs}ms.`;
        state.forcedExitCode = 1;
        result.stopReason = "error";
        result.errorMessage = message;
        appendBoundedStderr(result, `\n[pi-subagent] Killed: ${message}`);
        forceStopAndSettle();
      }, startupTimeoutMs);
    }

    const stdoutFramer = new JsonlFramer(flushLine);
    proc.stdout.on("data", (chunk: Buffer) => stdoutFramer.write(chunk));
    proc.stdout.on("end", () => stdoutFramer.end());

    const stderrDecoder = new StringDecoder("utf8");
    let stderrBuffer = "";
    const flushStderrLine = (line: string) => {
      if (!line || state.resolved) return;
      const leadMessage = parseLeadMessageStderrLine(line);
      if (leadMessage) {
        flushLine(JSON.stringify(leadMessage));
        return;
      }
      if (isProgressOnlyEvent(line, result)) {
        emitUpdate();
        return;
      }
      appendBoundedStderr(result, `${line}\n`);
    };

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += stderrDecoder.write(chunk);
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() || "";
      for (const line of lines) flushStderrLine(line);
      if (stderrBuffer.length > MAX_CAPTURED_STDERR_CHARS * 2) {
        appendBoundedStderr(result, stderrBuffer.slice(0, -MAX_CAPTURED_STDERR_CHARS));
        stderrBuffer = stderrBuffer.slice(-MAX_CAPTURED_STDERR_CHARS);
      }
    });

    const flushRemainingStderr = () => {
      stderrBuffer += stderrDecoder.end();
      if (!stderrBuffer) return;
      flushStderrLine(stderrBuffer);
      stderrBuffer = "";
    };

    const classifyUnexpectedExit = (code: number | null, exitSignal: NodeJS.Signals | null): number => {
      if (state.forcedExitCode !== undefined) return state.forcedExitCode;
      // Some launchers translate our expected SIGTERM into code 143. After
      // agent_settled, only the model result determines success.
      if (state.agentSettled) return isResultError({ ...result, exitCode: 0 }) ? 1 : 0;

      const message = exitSignal
        ? `Subagent process exited from signal ${exitSignal} before agent_settled.`
        : `Subagent process exited with code ${code ?? "null"} before agent_settled.`;
      result.stopReason = "error";
      result.errorMessage = message;
      appendBoundedStderr(result, `[pi-subagent] ${message}\n`);
      return code !== null && code !== 0 ? code : 1;
    };

    proc.on("close", (code, exitSignal) => {
      stdoutFramer.end();
      flushRemainingStderr();
      if (!state.resolved) doResolve(classifyUnexpectedExit(code, exitSignal));
    });

    proc.on("exit", (code, exitSignal) => {
      parked = parking.confirmExit();
      if (state.resolved) return;
      // `close` waits for stdio. A descendant can inherit stdout and keep it
      // open after the immediate Pi process exits, so bound that drain while
      // still allowing normal buffered JSONL to arrive before settlement.
      forceStopAndSettle(classifyUnexpectedExit(code, exitSignal));
    });

    proc.stdin?.on("error", (err) => {
      if (state.resolved) return;
      state.forcedExitCode = 1;
      result.stopReason = "error";
      result.errorMessage = `Subagent RPC stdin failed: ${err.message}`;
      appendBoundedStderr(result, `[pi-subagent] ${result.errorMessage}\n`);
      forceStopAndSettle(1);
    });

    proc.on("error", (err) => {
      if (!proc.pid) opts.treeAdmission?.release();
      appendBoundedStderr(result, `Spawn error: ${err.message}`);
      result.stopReason = "error";
      result.errorMessage = `Failed to spawn pi process: ${err.message}`;
      doResolve(1);
    });

    if (proc.pid && opts.treeAdmission) {
      try {
        if (!opts.treeAdmission.bindPid(proc.pid)) {
          state.wasAborted = true;
          state.forcedExitCode = 130;
          forceStopAndSettle(130, true);
        }
      } catch (error) {
        result.stopReason = "error";
        result.errorMessage = `Global worker admission failed: ${error instanceof Error ? error.message : String(error)}`;
        state.forcedExitCode = 1;
        forceStopAndSettle(1, true);
      }
    }
    if (signal) {
      abortHandler = () => {
        state.wasAborted = true;
        state.forcedExitCode = 130;
        forceStopAndSettle();
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      const handle = {
        ...createSteeringHandle({
          state,
          result,
          promptRequestId,
          sendRpc,
          noteSemanticActivity,
          timeoutMs: opts.steeringTimeoutMsOverride,
          settleDeferred: () => flushLine(JSON.stringify({ type: "agent_settled" })),
        }),
        park: () => parking.park(),
        kill: () => {
          if (state.resolved) return;
          state.wasAborted = true;
          state.forcedExitCode = 130;
          forceStopAndSettle(130, true);
        },
      };
      parking.register(handle);
      opts.onHandle?.(handle);
    } catch (error) {
      state.forcedExitCode = 1;
      result.stopReason = "error";
      result.errorMessage = `Subagent handle callback failed: ${error instanceof Error ? error.message : String(error)}`;
      forceStopAndSettle(1);
    }

    if (
      !state.wasAborted &&
      !state.resolved &&
      !state.stopping &&
      !sendRpc({ id: promptRequestId, type: "prompt", message: prompt, streamingBehavior: "steer" })
    ) {
      state.forcedExitCode = 1;
      result.stopReason = "error";
      result.errorMessage = "Failed to write the initial prompt to the subagent RPC process.";
      forceStopAndSettle(1);
    }
  });
  return { exitCode, startupTimedOut: state.startupTimedOut, wasAborted: state.wasAborted, parked };
}
