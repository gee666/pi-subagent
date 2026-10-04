import { loadSubagentSettings } from "../settings.js";
import { DEFAULT_AGENT } from "../agents.js";
import { emptyUsage, extractToolCalls, getFinalOutput, isResultError, type SingleResult } from "../types.js";
import { budgetPrompt, readBudget } from "../budget.js";
import {
  configuredNonNegativeInt,
  DEFAULT_STARTUP_RETRIES,
  SUBAGENT_STARTUP_RETRIES_ENV,
  STARTUP_RETRY_BASE_BACKOFF_MS,
} from "./constants.js";
import type { RunAgentOptions } from "./options.js";
import { buildPiArgs, resolveChildExtensionArgs, resolveLaunchModelSettings } from "./arguments.js";
import { readOriginalSessionSettings } from "../storage/session-settings.js";
import { updateNameRecord } from "../names.js";
import { writePromptToTempFile, cleanupTempDir, sessionDirExists } from "./files.js";
import { appendBoundedStderr, priorDescendantUsage, endedWithSyntheticResumeFailure } from "./result.js";
import { runAttempt } from "./attempt.js";
import { selectIntelligence } from "../intelligence.js";
import * as path from "node:path";
import { resolveSessionTarget } from "./session-target.js";
export async function runAgentSubprocess(opts: RunAgentOptions): Promise<SingleResult> {
  opts = { ...opts, settings: opts.settings ?? loadSubagentSettings(opts.cwd, opts.projectTrusted === true) };
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

  const agent =
    agents.find((a) => a.name === agentName) ??
    (agents.length === 0 && agentName === DEFAULT_AGENT.name ? DEFAULT_AGENT : undefined);
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
    model: opts.resumeSettings?.model ?? initialResult?.model ?? agent.model,
    thinking: opts.resumeSettings?.thinking,
    intelligence: opts.resumeSettings?.intelligence,
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

  // Enforce cycle prevention per task rather than rejecting an entire parallel
  // call. Legal siblings can still run while the cyclic task returns a normal
  // structured failure.
  if (agent.source !== "default" && preventCycles && parentAgentStack.includes(agentName)) {
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
    if (opts.signal?.aborted) {
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      emitUpdate();
      return result;
    }
    const target = resolveSessionTarget(opts.cwd, sessionDir, shouldContinueSession, !!opts.resumeSettings);
    // Approval is scoped to the caller's project, never transferable to a saved project's cwd.
    const projectTrusted = target.cwd === path.resolve(opts.cwd) && opts.projectTrusted === true;
    const childOpts = { ...opts, cwd: target.cwd, sessionDir: target.sessionDir, projectTrusted };
    const extensionArgs = await resolveChildExtensionArgs(target.cwd, projectTrusted, true, opts.settings);
    if (opts.signal?.aborted) {
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      emitUpdate();
      return result;
    }
    const selection = opts.resumeSettings
      ? undefined
      : selectIntelligence(opts.intelligencePresets, opts.intelligence, opts.settings);
    const settings = opts.resumeSettings ?? resolveLaunchModelSettings(agent, fallbackModel, selection, opts.settings);
    result.intelligence = settings.intelligence;
    result.model = settings.model;
    result.thinking = settings.thinking;
    emitUpdate();
    const { args: piArgs, prompt: taskPrompt } = buildPiArgs(
      agent,
      promptTmpPath,
      task,
      target.sessionDir,
      shouldContinueSession,
      fallbackModel,
      opts.rawPrompt === true,
      selection,
      extensionArgs,
      opts.resumeSettings,
      target.sessionFile,
      opts.settings,
    );
    const prompt =
      result.budget && readBudget(result.budget).limit > 0
        ? `${taskPrompt}\n\n${budgetPrompt(result.budget)}`
        : taskPrompt;
    let wasAborted = false;
    const startupRetries = configuredNonNegativeInt(
      SUBAGENT_STARTUP_RETRIES_ENV,
      DEFAULT_STARTUP_RETRIES,
      false,
      opts.settings,
    );
    let startupTimedOut = false;
    let exitCode = -1;

    for (let attempt = 0; ; attempt++) {
      startupTimedOut = false;
      const outcome = await runAttempt(
        opts.resumeSettings ? { ...childOpts, fallbackModel: settings.model } : childOpts,
        result,
        piArgs,
        prompt,
        attempt,
        emitUpdate,
      );
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
    emitUpdate();
    return result;
  } finally {
    cleanupTempDir(promptTmpDir);
    if (!resumeSession && opts.namesFile && opts.subagentName && sessionDir) {
      const original = readOriginalSessionSettings(sessionDir);
      result.thinking = original.thinking ?? result.thinking;
      await updateNameRecord(opts.namesFile, opts.subagentName, {
        model: original.model ?? result.model,
        thinking: result.thinking,
        intelligence: result.intelligence,
      });
    }
  }
}
