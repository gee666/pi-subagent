import { emptyUsage, extractToolCalls, getFinalOutput, isResultError, type SingleResult } from "../types.js";
import { budgetPrompt } from "../budget.js";
import {
  configuredNonNegativeInt,
  DEFAULT_STARTUP_RETRIES,
  SUBAGENT_STARTUP_RETRIES_ENV,
  STARTUP_RETRY_BASE_BACKOFF_MS,
} from "./constants.js";
import type { RunAgentOptions } from "./options.js";
import { buildPiArgs } from "./arguments.js";
import { writePromptToTempFile, cleanupTempDir, sessionDirExists } from "./files.js";
import { appendBoundedStderr, priorDescendantUsage, endedWithSyntheticResumeFailure } from "./result.js";
import { runAttempt } from "./attempt.js";
export async function runAgentSubprocess(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    agents,
    agentName,
    task,
    parentAgentStack,
    preventCycles,
    onUpdate,
    makeDetails,
    sessionDir,
    resumeSession = false,
    initialResult,
    fallbackModel,
  } = opts;

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      name: opts.subagentName,
      startedAt: Date.now(),
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      toolCalls: {},
      completedTurns: 0,
      turnInProgress: false,
      liveLog: [],
      sessionDir: opts.sessionDir,
    };
  }

  const shouldContinueSession = resumeSession && (!sessionDir || sessionDirExists(sessionDir));

  const initialMessageCount = initialResult?.messages?.length ?? 0;

  const result: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    name: opts.subagentName ?? initialResult?.name,
    budget: opts.budget ?? initialResult?.budget,
    startedAt: initialResult?.startedAt ?? Date.now(),
    lastActionAt: initialResult?.lastActionAt ?? Date.now(),
    exitCode: -1,
    messages: initialResult?.messages ? [...initialResult.messages] : [],
    stderr: initialResult?.stderr ?? "",
    usage: initialResult?.usage ? { ...initialResult.usage } : emptyUsage(),
    toolCalls: initialResult?.toolCalls ? { ...initialResult.toolCalls } : {},
    model: initialResult?.model ?? agent.model,
    completedTurns: initialResult?.completedTurns ?? 0,
    turnInProgress: false,
    liveToolExecutions: initialResult?.liveToolExecutions,
    liveLog: initialResult?.liveLog ? [...initialResult.liveLog] : [],
    liveNestedSubagents: initialResult?.liveNestedSubagents ? { ...initialResult.liveNestedSubagents } : undefined,
    priorDescendantUsageSummary: priorDescendantUsage(initialResult),
    sessionDir,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(result.messages, result.finalOutput) || "(running...)",
        },
      ],
      details: (makeDetails.live ?? makeDetails)([result]),
    });
  };

  emitUpdate();

  // Enforce cycle prevention per task rather than rejecting an entire parallel
  // call. Legal siblings can still run while the cyclic task returns a normal
  // structured failure.
  if (preventCycles && parentAgentStack.includes(agentName)) {
    const stackText = parentAgentStack.length > 0 ? parentAgentStack.join(" -> ") : "(root)";
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = `Delegation cycle detected: agent "${agentName}" is already in the delegation stack (${stackText}).`;
    result.stderr = result.errorMessage;
    emitUpdate();
    return result;
  }

  // Write system prompt to temp file if needed
  let promptTmpDir: string | null = null;
  let promptTmpPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
    promptTmpDir = tmp.dir;
    promptTmpPath = tmp.filePath;
  }

  try {
    const { args: piArgs, prompt: taskPrompt } = buildPiArgs(
      agent,
      promptTmpPath,
      task,
      sessionDir,
      shouldContinueSession,
      fallbackModel,
      opts.rawPrompt === true,
    );
    const prompt = result.budget ? `${taskPrompt}\n\n${budgetPrompt(result.budget)}` : taskPrompt;
    let wasAborted = false;
    const startupRetries = configuredNonNegativeInt(SUBAGENT_STARTUP_RETRIES_ENV, DEFAULT_STARTUP_RETRIES);
    let startupTimedOut = false;
    let exitCode = -1;

    for (let attempt = 0; ; attempt++) {
      startupTimedOut = false;
      const outcome = await runAttempt(opts, result, piArgs, prompt, attempt, emitUpdate);
      exitCode = outcome.exitCode;
      startupTimedOut = outcome.startupTimedOut;
      wasAborted = outcome.wasAborted;

      const noProgress = result.messages.length <= initialMessageCount;
      const canRetry = startupTimedOut && !wasAborted && noProgress && attempt < startupRetries;
      if (!canRetry) break;

      // Transient cold-start stall: clear the error markers the startup timer
      // set on `result`, then re-spawn a clean child. The per-attempt startup
      // window is unchanged; we just give the child another chance to boot.
      result.exitCode = -1;
      result.stopReason = undefined;
      result.errorMessage = undefined;
      appendBoundedStderr(
        result,
        `\n[pi-subagent] Startup timeout; retrying (attempt ${attempt + 2}/${startupRetries + 1}).`,
      );
      emitUpdate();
      await new Promise<void>((resolve) => setTimeout(resolve, STARTUP_RETRY_BASE_BACKOFF_MS * (attempt + 1)));
    }

    result.exitCode = exitCode;
    result.toolCalls = extractToolCalls(result.messages); // populate from parsed messages
    if (result.exitCode === 0 && isResultError(result)) {
      result.exitCode = 1;
    }
    if (result.stopReason === "length" && !result.errorMessage) {
      result.errorMessage = "Subagent output was incomplete because the model reached its output limit.";
      if (!result.stderr.trim()) result.stderr = result.errorMessage;
    }
    if (wasAborted) {
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
    }

    if (result.exitCode === 0 && shouldContinueSession && result.messages.length <= initialMessageCount) {
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage =
        "Subagent resume made no progress: resumed subprocess exited without producing any new messages.";
      if (!result.stderr.trim()) result.stderr = result.errorMessage;
    }

    if (result.exitCode === 0 && endedWithSyntheticResumeFailure(result.messages)) {
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = "Subagent resume failed before the real model continued.";
      if (!result.stderr.trim()) result.stderr = result.errorMessage;
    }

    // A failed nested delegation is a recoverable tool error, just like a
    // failed bash/read call. Pi returns that error to the calling model, which
    // may retry, choose another approach, or finish the task itself. Do not
    // overwrite a later successful terminal answer with an earlier nested
    // tool failure.
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.exitCode = result.exitCode === -1 ? 1 : result.exitCode;
    result.stopReason = result.stopReason ?? "error";
    result.errorMessage = result.errorMessage ?? msg;
    if (!result.stderr.trim()) result.stderr = msg;
    return result;
  } finally {
    cleanupTempDir(promptTmpDir);
  }
}
