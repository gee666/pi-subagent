import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isResultError, type SingleResult } from "../types.js";
import { SUBAGENT_SESSION_ROOT_ENV } from "../resume.js";
import { SUBAGENT_NAMES_FILE_ENV } from "../names.js";
import { SUBAGENT_BUDGET_DIR_ENV } from "../budget.js";
import {
  configuredNonNegativeInt,
  SIGKILL_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  SUBAGENT_STARTUP_TIMEOUT_ENV,
  DEFAULT_IDLE_TIMEOUT_MS,
  SUBAGENT_IDLE_TIMEOUT_ENV,
  MAX_CAPTURED_STDERR_CHARS,
  SUBAGENT_DEPTH_ENV,
  SUBAGENT_MAX_DEPTH_ENV,
  SUBAGENT_STACK_ENV,
  SUBAGENT_PREVENT_CYCLES_ENV,
  SUBAGENT_FALLBACK_MODEL_ENV,
} from "./constants.js";
import { getPiSpawnCommand, buildChildProcessEnv, stopProcessTree } from "./launch.js";
import { appendBoundedStderr } from "./result.js";
import { isProgressOnlyEvent } from "./events.js";
import { createProtocolHandler } from "./protocol.js";
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
): Promise<{ exitCode: number; startupTimedOut: boolean; wasAborted: boolean }> {
  const {
    cwd,
    parentDepth,
    maxDepth,
    parentAgentStack,
    agentName,
    preventCycles,
    sessionRoot,
    fallbackModel,
    piCommandOverride,
    startupTimeoutMsOverride,
    idleTimeoutMsOverride,
    terminationTimeoutMsOverride,
    signal,
  } = opts;
  const state: AttemptState = {
    resolved: false,
    receivedFirstEvent: false,
    agentSettled: false,
    startupTimedOut: false,
    wasAborted: false,
    activeToolCallIds: new Set(),
  };
  const exitCode = await new Promise<number>((resolve) => {
    const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
    const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
    const propagatedStack = [...parentAgentStack, agentName];
    // On Windows, `pi` is a .CMD shim that requires the shell to execute,
    // but shell:true splits arguments on whitespace — breaking task strings.
    // Fix: reuse the running node binary + the pi CLI script path directly,
    // so the child is spawned without a shell and args are passed safely.
    const piSpawn = getPiSpawnCommand(piCommandOverride);
    const spawnCmd = piSpawn.command;
    const spawnArgs = [...piSpawn.argsPrefix, ...piArgs];
    const proc = spawn(spawnCmd, spawnArgs, {
      cwd,
      shell: false,
      // A separate POSIX process group lets timeout/cancel terminate nested
      // agents and tools, rather than only their immediate Pi parent.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: buildChildProcessEnv({
        [SUBAGENT_DEPTH_ENV]: String(nextDepth),
        [SUBAGENT_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
        [SUBAGENT_STACK_ENV]: JSON.stringify(propagatedStack),
        [SUBAGENT_PREVENT_CYCLES_ENV]: preventCycles ? "1" : "0",
        ...(sessionRoot ? { [SUBAGENT_SESSION_ROOT_ENV]: sessionRoot } : {}),
        ...(opts.namesFile ? { [SUBAGENT_NAMES_FILE_ENV]: opts.namesFile } : {}),
        // Never let an unbudgeted child inherit its parent's spendable slots.
        [SUBAGENT_BUDGET_DIR_ENV]: result.budget?.directory ?? "",
        ...(fallbackModel ? { [SUBAGENT_FALLBACK_MODEL_ENV]: fallbackModel } : {}),
        // All other provider/auth/proxy/temp/home variables are inherited.
        // PI_OFFLINE is inherited, never forced by this runner.
      }),
    });

    let buffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let abortHandler: (() => void) | undefined;
    const promptRequestId = `pi-subagent-${process.pid}-${Date.now()}-${attempt}`;
    let steeringRequest = 0;

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

    opts.onHandle?.({
      steer(message: string) {
        // Use "prompt" with streamingBehavior "steer" instead of the raw
        // "steer" RPC command. Pi's `session.steer()` bypasses the `input`
        // extension hook entirely, so the child's pi-subagent extension would
        // never see encoded nested-broadcast messages and could not forward
        // them to its own (grand)children. `session.prompt()` emits the
        // `input` event first and still queues the message as a steering
        // message while the child is streaming.
        sendRpc({
          id: `${promptRequestId}-steer-${++steeringRequest}`,
          type: "prompt",
          message,
          streamingBehavior: "steer",
        });
      },
    });

    // Startup timeout: kill the process if it never produces its first
    // model-turn event. Once startup succeeds, the semantic-inactivity
    // watchdog below takes over.
    const startupTimeoutMs =
      startupTimeoutMsOverride ?? configuredNonNegativeInt(SUBAGENT_STARTUP_TIMEOUT_ENV, DEFAULT_STARTUP_TIMEOUT_MS);

    const doResolve = (code: number) => {
      if (state.resolved) return;
      state.resolved = true;
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
      resolve(code);
    };

    const stopChild = (force: boolean) => stopProcessTree(proc, force);

    const forceStopAndSettle = (settleCode = state.forcedExitCode ?? 1) => {
      stopChild(false);
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
        : configuredNonNegativeInt(SUBAGENT_IDLE_TIMEOUT_ENV, DEFAULT_IDLE_TIMEOUT_MS);

    const noteSemanticActivity = (minimumQuietPeriodMs = 0) => {
      if (state.idleTimer) {
        clearTimeout(state.idleTimer);
        state.idleTimer = undefined;
      }
      if (!state.receivedFirstEvent || idleTimeoutMs === 0 || state.resolved) return;
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

    const flushLine = createProtocolHandler({
      state,
      result,
      promptRequestId,
      emitUpdate,
      noteSemanticActivity,
      stopChild,
      doResolve,
      forceStopAndSettle,
    });

    // Start the startup timer — if the child process never reaches the
    // LLM-call phase (hung during init, broken binary, slow MCP adapter, etc.),
    // kill it. The idle watchdog replaces it after the first turn_start or
    // completed assistant turn.
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

    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += stdoutDecoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (let line of lines) {
        if (line.endsWith("\r")) line = line.slice(0, -1);
        flushLine(line);
      }
    });
    proc.stdout.on("end", () => {
      buffer += stdoutDecoder.end();
    });

    let stderrBuffer = "";
    const flushStderrLine = (line: string) => {
      if (!line) return;
      if (isProgressOnlyEvent(line, result)) {
        emitUpdate();
        return;
      }
      appendBoundedStderr(result, `${line}\n`);
    };

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() || "";
      for (const line of lines) flushStderrLine(line);
      if (stderrBuffer.length > MAX_CAPTURED_STDERR_CHARS * 2) {
        appendBoundedStderr(result, stderrBuffer.slice(0, -MAX_CAPTURED_STDERR_CHARS));
        stderrBuffer = stderrBuffer.slice(-MAX_CAPTURED_STDERR_CHARS);
      }
    });

    const flushRemainingStderr = () => {
      if (!stderrBuffer) return;
      flushStderrLine(stderrBuffer);
      stderrBuffer = "";
    };

    const classifyUnexpectedExit = (code: number | null, exitSignal: NodeJS.Signals | null): number => {
      if (state.forcedExitCode !== undefined) return state.forcedExitCode;
      // Once Pi emitted agent_settled, the semantic run is complete and this
      // runner deliberately terminates the still-listening RPC process. Some
      // launchers translate that expected SIGTERM into exit code 143 rather
      // than reporting a signal. Do not turn our own cleanup status into a
      // failed subagent; only the settled model result determines success.
      if (state.agentSettled) return isResultError({ ...result, exitCode: 0 }) ? 1 : 0;

      const message = exitSignal
        ? `Subagent process exited from signal ${exitSignal} before agent_settled.`
        : `Subagent process exited with code ${code ?? "null"} before agent_settled.`;
      result.stopReason = "error";
      result.errorMessage = message;
      appendBoundedStderr(result, `[pi-subagent] ${message}\n`);
      return code !== null && code !== 0 ? code : 1;
    };

    const flushRemainingStdout = () => {
      if (!buffer.trim()) return;
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      buffer = "";
      flushLine(line);
    };

    proc.on("close", (code, exitSignal) => {
      flushRemainingStdout();
      flushRemainingStderr();
      if (!state.resolved) doResolve(classifyUnexpectedExit(code, exitSignal));
    });

    proc.on("exit", (code, exitSignal) => {
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
      appendBoundedStderr(result, `Spawn error: ${err.message}`);
      result.stopReason = "error";
      result.errorMessage = `Failed to spawn pi process: ${err.message}`;
      doResolve(1);
    });

    // Abort handling
    if (signal) {
      abortHandler = () => {
        state.wasAborted = true;
        state.forcedExitCode = 130;
        forceStopAndSettle();
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    if (!state.wasAborted && !state.resolved && !sendRpc({ id: promptRequestId, type: "prompt", message: prompt })) {
      state.forcedExitCode = 1;
      result.stopReason = "error";
      result.errorMessage = "Failed to write the initial prompt to the subagent RPC process.";
      forceStopAndSettle(1);
    }
  });
  return { exitCode, startupTimedOut: state.startupTimedOut, wasAborted: state.wasAborted };
}
