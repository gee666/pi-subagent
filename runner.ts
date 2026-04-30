/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.js";
import {
  type LiveLogEntry,
  type SingleResult,
  type SubagentDetails,
  MAX_LIVE_LOG_ENTRIES,
  emptyUsage,
  extractToolCalls,
  getFinalOutput,
  getNestedSubagentErrorSummary,
} from "./types.js";
import { SUBAGENT_SESSION_ROOT_ENV } from "./resume.js";
import {
  DEFAULT_MAX_PARALLEL_TASKS,
  DEFAULT_MAX_CONCURRENCY,
  PARALLEL_HEARTBEAT_MS,
  RESUME_MODEL_ID,
  RESUME_PROVIDER,
  SUBAGENT_MAX_PARALLEL_TASKS_ENV,
  SUBAGENT_MAX_CONCURRENCY_ENV,
  parseNonNegativeInt,
  mapConcurrent,
} from "./shared.js";

const SIGKILL_TIMEOUT_MS = 5000;
const HANG_GUARD_DELAY_MS = 5000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000; // only for startup (before first assistant turn)
const SUBAGENT_STARTUP_TIMEOUT_ENV = "PI_SUBAGENT_STARTUP_TIMEOUT";

/**
 * Stop reasons that indicate the agent has truly finished its work.
 * "tool_use" is NOT terminal — the agent is still working (calling a tool).
 */
// pi emits "stop" (and occasionally "end_turn") as the terminal reason; include both.
// "toolUse"/"tool_use" are NOT terminal — the agent is still mid-turn calling a tool.
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop", "max_tokens", "error", "stop_sequence"]);

function isTerminalStopReason(reason: string | undefined): boolean {
  return reason !== undefined && TERMINAL_STOP_REASONS.has(reason);
}

function endedWithSyntheticResumeFailure(messages: Message[]): boolean {
  const lastAssistant = [...messages].reverse().find((message: any) => message?.role === "assistant") as any;
  if (lastAssistant?.provider !== RESUME_PROVIDER || lastAssistant?.model !== RESUME_MODEL_ID) return false;
  const content = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
  const handedOffToRealModel = messages.some((message: any) => message?.role === "assistant" && message.provider !== RESUME_PROVIDER);
  const hasToolCall = content.some((part: any) => part?.type === "toolCall");
  return !handedOffToRealModel && !hasToolCall;
}
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_FALLBACK_MODEL_ENV = "PI_SUBAGENT_FALLBACK_MODEL";

// PI_OFFLINE intentionally removed: setting it on child processes blocks all API
// calls and renders subagents unable to do any LLM work. Children inherit the
// parent's PI_OFFLINE value via process.env spread if needed.

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function getCurrentPiCliScript(): string | null {
  const script = process.argv[1];
  if (!script) return null;

  // When this extension is loaded by pi, process.argv[1] is the pi CLI JS
  // entrypoint. Reusing it with process.execPath avoids relying on PATH while
  // still running the exact same pi installation as the parent process.
  const normalized = script.replace(/\\/g, "/");
  if (!normalized.includes("/pi-coding-agent/") || !normalized.endsWith("/dist/cli.js")) {
    return null;
  }

  return script;
}

function resolveExtensionArg(value: string): string {
  if (!value) return value;
  if (value.startsWith("npm:") || value.startsWith("git:")) return value;
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value)) return value;

  const resolved = path.resolve(process.cwd(), value);
  return fs.existsSync(resolved) ? resolved : value;
}

interface InheritedCliArgs {
  /** --extension/-e and --no-extensions/-ne args (with path resolution) */
  extensionArgs: string[];
  /** All other non-blocked flags to forward verbatim to every child */
  alwaysProxy: string[];
  /** Parent --model value; used only when agent config doesn't specify model */
  fallbackModel: string | undefined;
  /** Parent --thinking value; used only when agent config doesn't specify thinking */
  fallbackThinking: string | undefined;
  /** Parent --tools value; used only when agent config doesn't specify tools */
  fallbackTools: string | undefined;
  /** Parent passed --no-tools; used only when agent config doesn't specify tools */
  fallbackNoTools: boolean;
}

/**
 * Parse process.argv into categorised groups for child-process arg construction.
 *
 * Categories:
 *  - BLOCKED       : flags the extension manages itself — never forwarded
 *  - extensionArgs : --extension/-e and --no-extensions/-ne (with path resolution)
 *  - alwaysProxy   : all other non-blocked flags forwarded verbatim
 *  - fallback*     : flags the agent config may override
 *
 * Handles both "--flag value" and "--flag=value" forms.
 * Unknown flags use a heuristic: if the next token doesn't start with "-",
 * it is treated as the flag's value.
 */
function parseInheritedCliArgs(argv: string[]): InheritedCliArgs {
  const extensionArgs: string[] = [];
  const alwaysProxy: string[] = [];
  let fallbackModel: string | undefined;
  let fallbackThinking: string | undefined;
  let fallbackTools: string | undefined;
  let fallbackNoTools = false;

  let i = 2; // skip "node" and "pi"
  while (i < argv.length) {
    const raw = argv[i];
    // Positional args (prompt text, @file refs) — skip, not proxied to children
    if (!raw.startsWith("-")) { i++; continue; }

    // Normalise: detect --flag=value inline form
    const eqIdx = raw.indexOf("=");
    const flagName = eqIdx !== -1 ? raw.slice(0, eqIdx) : raw;
    const inlineValue: string | undefined = eqIdx !== -1 ? raw.slice(eqIdx + 1) : undefined;

    const nextToken = argv[i + 1];
    const nextIsValue = nextToken !== undefined && !nextToken.startsWith("-");

    // Returns [resolvedValue | undefined, tokensToConsume]
    const getVal = (): [string | undefined, number] => {
      if (inlineValue !== undefined) return [inlineValue, 1];
      if (nextIsValue) return [nextToken, 2];
      return [undefined, 1];
    };

    // ── BLOCKED: value flags ─────────────────────────────────────────────────
    // Extension manages these; consume flag + value, never proxy.
    if ([
      "--mode", "--session", "--append-system-prompt",
      "--export", "--subagent-max-depth",
    ].includes(flagName)) {
      const [, skip] = getVal();
      i += skip; continue;
    }

    // --subagent-prevent-cycles takes an optional value
    if (flagName === "--subagent-prevent-cycles") {
      if (inlineValue !== undefined || nextIsValue) { i += inlineValue !== undefined ? 1 : 2; }
      else { i++; }
      continue;
    }

    // --list-models has an optional search term
    if (flagName === "--list-models") {
      if (inlineValue !== undefined || nextIsValue) { i += inlineValue !== undefined ? 1 : 2; }
      else { i++; }
      continue;
    }

    // ── BLOCKED: boolean flags ────────────────────────────────────────────────
    if ([
      "--print", "-p", "--no-session",
      "--continue", "-c", "--resume", "-r",
      "--offline", "--help", "-h", "--version", "-v",
      "--no-subagent-prevent-cycles",
    ].includes(flagName)) {
      i++; continue;
    }

    // ── EXTENSION FLAGS: handled separately with path resolution ─────────────
    if (flagName === "--no-extensions" || flagName === "-ne") {
      extensionArgs.push(flagName);
      i++; continue;
    }
    if (flagName === "--extension" || flagName === "-e") {
      const [value, skip] = getVal();
      if (value !== undefined) extensionArgs.push(flagName, resolveExtensionArg(value));
      i += skip; continue;
    }

    // ── ALWAYS-PROXY: known value flags ──────────────────────────────────────
    if ([
      "--provider", "--api-key", "--system-prompt",
      "--models", "--skill", "--prompt-template", "--theme",
    ].includes(flagName)) {
      const [value, skip] = getVal();
      if (value !== undefined) alwaysProxy.push(flagName, value);
      i += skip; continue;
    }

    // ── ALWAYS-PROXY: known boolean flags ────────────────────────────────────
    if ([
      "--no-skills", "-ns", "--no-prompt-templates", "-np",
      "--no-themes", "--verbose",
    ].includes(flagName)) {
      alwaysProxy.push(flagName);
      i++; continue;
    }

    // ── FALLBACK: agent config may override ───────────────────────────────────
    if (flagName === "--model") {
      const [value, skip] = getVal();
      if (value !== undefined) fallbackModel = value;
      i += skip; continue;
    }
    if (flagName === "--thinking") {
      const [value, skip] = getVal();
      if (value !== undefined) fallbackThinking = value;
      i += skip; continue;
    }
    if (flagName === "--tools") {
      const [value, skip] = getVal();
      if (value !== undefined) fallbackTools = value;
      i += skip; continue;
    }
    if (flagName === "--no-tools") {
      fallbackNoTools = true;
      i++; continue;
    }

    // ── UNKNOWN: heuristic passthrough ───────────────────────────────────────
    // Likely a custom extension flag. Forward with value if next token looks like one.
    if (inlineValue !== undefined) {
      alwaysProxy.push(flagName, inlineValue);
      i++; continue;
    }
    if (nextIsValue) {
      alwaysProxy.push(flagName, nextToken);
      i += 2; continue;
    }
    alwaysProxy.push(flagName);
    i++;
  }

  return { extensionArgs, alwaysProxy, fallbackModel, fallbackThinking, fallbackTools, fallbackNoTools };
}

/** Cached once — process.argv is immutable at runtime */
const _inheritedCliArgs = parseInheritedCliArgs(process.argv);

// ---------------------------------------------------------------------------
// JSON-line stream processing
// ---------------------------------------------------------------------------

function pushLiveLog(result: SingleResult, entry: LiveLogEntry): void {
  result.liveLog.push(entry);
  if (result.liveLog.length > MAX_LIVE_LOG_ENTRIES) result.liveLog.shift();
}

function messageDedupKey(message: Message): string {
  const anyMessage = message as any;
  if (typeof anyMessage.id === "string") return `id:${anyMessage.id}`;
  return JSON.stringify({
    role: anyMessage.role,
    provider: anyMessage.provider,
    model: anyMessage.model,
    stopReason: anyMessage.stopReason,
    toolCallId: anyMessage.toolCallId,
    toolName: anyMessage.toolName,
    content: anyMessage.content,
    usage: anyMessage.usage,
  });
}

function hasMessage(result: SingleResult, message: Message): boolean {
  const key = messageDedupKey(message);
  return result.messages.some((existing) => messageDedupKey(existing) === key);
}

function sessionDirExists(dir: string | undefined): boolean {
  if (!dir) return false;
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function processJsonLine(line: string, result: SingleResult): boolean {
  if (!line.trim()) return false;

  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  // Guard: JSON.parse can return null, a number, boolean, or array — none of which have .type
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;

  if (event.type === "message_end" && event.message) {
    const msg = event.message as Message;
    if (hasMessage(result, msg)) return true;
    result.messages.push(msg);

    if (msg.role === "assistant") {
      result.usage.turns++;
      const usage = msg.usage;
      if (usage) {
        result.usage.input += usage.input || 0;
        result.usage.output += usage.output || 0;
        result.usage.cacheRead += usage.cacheRead || 0;
        result.usage.cacheWrite += usage.cacheWrite || 0;
        result.usage.cost += usage.cost?.total || 0;
        result.usage.contextTokens = usage.totalTokens || 0;
      }
      if (msg.model && msg.model !== "synthetic-tool-call") result.model = msg.model;
      if (msg.stopReason) result.stopReason = msg.stopReason;
      if (msg.errorMessage) result.errorMessage = msg.errorMessage;
    }
    return true;
  }

  if (event.type === "tool_result_end" && event.message) {
    const msg = event.message as Message;
    if (!hasMessage(result, msg)) result.messages.push(msg);
    return true;
  }

  if (event.type === "turn_start") {
    result.turnInProgress = true;
    pushLiveLog(result, { kind: "turn_start" });
    return true;
  }

  if (event.type === "turn_end") {
    result.completedTurns++;
    result.turnInProgress = false;
    const u = event.message?.usage;
    pushLiveLog(result, {
      kind: "turn_end",
      turn: result.completedTurns,
      inputTokens: u?.input ?? 0,
      outputTokens: u?.output ?? 0,
    });
    return true;
  }

  if (event.type === "tool_execution_start") {
    result.liveToolExecutions ??= {};
    result.liveToolExecutions[event.toolCallId] = {
      toolName: event.toolName,
      args: event.args,
    };
    pushLiveLog(result, { kind: "tool_start", toolName: event.toolName, args: event.args });
    return true;
  }

  if (event.type === "tool_execution_end") {
    if (result.liveToolExecutions) {
      delete result.liveToolExecutions[event.toolCallId];
    }
    pushLiveLog(result, { kind: "tool_end", toolName: event.toolName });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

function buildPiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  task: string,
  sessionDir: string | undefined,
  resumeSession: boolean,
  fallbackModelOverride?: string,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ..._inheritedCliArgs.extensionArgs,
    ..._inheritedCliArgs.alwaysProxy,
  ];

  if (sessionDir) args.push("--session-dir", sessionDir);
  if (resumeSession) args.push("--continue");
  args.push("-p");

  // Agent config takes priority; fall back to parent CLI value
  const model = agent.model ?? fallbackModelOverride ?? process.env[SUBAGENT_FALLBACK_MODEL_ENV] ?? _inheritedCliArgs.fallbackModel;
  if (model) args.push("--model", model);

  const thinking = agent.thinking ?? _inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  // agent.tools is set only when the agent file specifies tools (length > 0)
  if (agent.tools && agent.tools.length > 0) {
    // Always include "subagent" so children can re-delegate when depth allows.
    // The child extension only registers the tool when canDelegate is true,
    // so listing it here is harmless when nested delegation is disabled.
    const toolsWithSubagent = agent.tools.includes("subagent")
      ? agent.tools
      : [...agent.tools, "subagent"];
    args.push("--tools", toolsWithSubagent.join(","));
  } else if (agent.tools === undefined) {
    // Agent didn't restrict tools — inherit parent's preference
    if (_inheritedCliArgs.fallbackTools !== undefined) {
      args.push("--tools", _inheritedCliArgs.fallbackTools);
    } else if (_inheritedCliArgs.fallbackNoTools) {
      args.push("--no-tools");
    }
  }

  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  args.push(
    resumeSession
      ? `Continue the previous task from where you left off. Original task: ${task}`
      : `Task: ${task}`,
  );
  return args;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Fallback working directory when the task doesn't specify one. */
  cwd: string;
  /** All available agent configs. */
  agents: AgentConfig[];
  /** Name of the agent to run. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Optional override working directory. */
  taskCwd?: string;
  /** Current delegation depth of the caller process. */
  parentDepth: number;
  /** Delegation stack from the caller process (ancestor agent names). */
  parentAgentStack: string[];
  /** Maximum allowed delegation depth to propagate to child processes. */
  maxDepth: number;
  /** Whether cycle prevention should be enforced in child processes. */
  preventCycles: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Factory to wrap results into SubagentDetails. */
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  /** Dedicated session directory for this subagent process. */
  sessionDir?: string;
  /** Top-level root for all subagent session directories in this delegation tree. */
  sessionRoot?: string;
  /** Continue the most recent session in sessionDir instead of creating a new one. */
  resumeSession?: boolean;
  /** Previously captured state for this same subagent, used to render resumed nested trees. */
  initialResult?: SingleResult;
  /** Fallback model to use when the agent config does not pin one. */
  fallbackModel?: string;
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runAgentSubprocess(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agents,
    agentName,
    task,
    taskCwd,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    signal,
    onUpdate,
    makeDetails,
    sessionDir,
    sessionRoot,
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

  const result: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
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
    sessionDir,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(result.messages) || "(running...)",
        },
      ],
      details: makeDetails([result]),
    });
  };

  emitUpdate();

  // Write system prompt to temp file if needed
  let promptTmpDir: string | null = null;
  let promptTmpPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
    promptTmpDir = tmp.dir;
    promptTmpPath = tmp.filePath;
  }

  try {
    const piArgs = buildPiArgs(
      agent,
      promptTmpPath,
      task,
      sessionDir,
      shouldContinueSession,
      fallbackModel,
    );
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const nextDepth = Math.max(0, Math.floor(parentDepth)) + 1;
      const propagatedMaxDepth = Math.max(0, Math.floor(maxDepth));
      const propagatedStack = [...parentAgentStack, agentName];
      // On Windows, `pi` is a .CMD shim that requires the shell to execute,
      // but shell:true splits arguments on whitespace — breaking task strings.
      // Fix: reuse the running node binary + the pi CLI script path directly,
      // so the child is spawned without a shell and args are passed safely.
      const currentPiCli = getCurrentPiCliScript();
      const spawnCmd = currentPiCli ? process.execPath : "pi";
      const spawnArgs = currentPiCli ? [currentPiCli, ...piArgs] : piArgs;
      const proc = spawn(spawnCmd, spawnArgs, {
        cwd: taskCwd ?? cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          [SUBAGENT_DEPTH_ENV]: String(nextDepth),
          [SUBAGENT_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
          [SUBAGENT_STACK_ENV]: JSON.stringify(propagatedStack),
          [SUBAGENT_PREVENT_CYCLES_ENV]: preventCycles ? "1" : "0",
          ...(sessionRoot ? { [SUBAGENT_SESSION_ROOT_ENV]: sessionRoot } : {}),
          ...(fallbackModel ? { [SUBAGENT_FALLBACK_MODEL_ENV]: fallbackModel } : {}),
          // PI_OFFLINE is NOT forced here — see explanation near PI_OFFLINE_ENV.
        },
      });

      let buffer = "";
      let resolved = false;
      let hangTimer: ReturnType<typeof setTimeout> | undefined;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      let receivedFirstEvent = false;

      // Startup timeout: kill the process if it never produces its first
      // JSON event. Once the first event arrives, this timer is permanently
      // disabled — from that point, tool calls can run for as long as they
      // need, and only the terminal-stopReason hang guard applies.
      const startupTimeoutMs = (() => {
        const raw = process.env[SUBAGENT_STARTUP_TIMEOUT_ENV];
        if (raw === undefined) return DEFAULT_STARTUP_TIMEOUT_MS;
        const parsed = parseNonNegativeInt(raw);
        return parsed !== null ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
      })();

      const doResolve = (code: number) => {
        if (resolved) return;
        resolved = true;
        if (hangTimer) { clearTimeout(hangTimer); hangTimer = undefined; }
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
        if (buffer.trim()) flushLine(buffer);
        resolve(code);
      };

      /**
       * Cancel any pending hang guard timer.
       * Called on every new activity to prove the child is still working.
       */
      const cancelHangGuard = () => {
        if (hangTimer) { clearTimeout(hangTimer); hangTimer = undefined; }
      };

      /**
       * Schedule a hang guard: if the child process produced a terminal
       * stopReason (agent finished) but doesn't exit on its own (due to
       * open handles like MCP connections, dangling timers, etc.),
       * force-kill it so the parent doesn't hang forever.
       *
       * The guard is reset on every new activity and only armed for
       * truly terminal stop reasons (not "tool_use").
       */
      const scheduleHangGuard = () => {
        if (resolved) return;
        cancelHangGuard();
        hangTimer = setTimeout(() => {
          if (resolved) return;
          // Process produced all output but won't exit — force-kill it
          try { proc.kill("SIGTERM"); } catch { /* already dead */ }
          setTimeout(() => {
            if (!resolved) {
              try { proc.kill("SIGKILL"); } catch { /* already dead */ }
            }
          }, SIGKILL_TIMEOUT_MS);
        }, HANG_GUARD_DELAY_MS);
      };

      const flushLine = (line: string) => {
        const accepted = processJsonLine(line, result);
        if (accepted) {
          // Cancel the startup timer as soon as the subprocess proves it has
          // reached the LLM-call phase. Two conditions qualify:
          //   1. A turn has started (turn_start sets turnInProgress=true) —
          //      the subprocess has initialised, loaded all extensions (including
          //      MCP adapters), and sent its first request to the LLM.  The LLM
          //      may now take any amount of time to respond (especially with
          //      extended thinking enabled) and must NOT be killed by the startup
          //      timer.
          //   2. A complete assistant turn has arrived (turns > 0) — the LLM
          //      already responded; startup trivially succeeded.
          // User message echoes alone (before turn_start) don't qualify:
          // the process could still stall before dispatching the LLM call,
          // e.g. in a hanging before_agent_start extension hook.
          if (!receivedFirstEvent && (result.usage.turns > 0 || result.turnInProgress)) {
            receivedFirstEvent = true;
            if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
          }
          emitUpdate();
          // Any accepted message means the child is alive and producing
          // output — cancel any pending hang guard so we don't kill it
          // while it's still working (e.g. during tool execution).
          cancelHangGuard();
          // Only arm the hang guard when the agent has truly finished.
          // "tool_use" means the agent is still working — NOT terminal.
          if (isTerminalStopReason(result.stopReason)) {
            scheduleHangGuard();
          }
        }
      };

      // Start the startup timer — if the child process never reaches the
      // LLM-call phase (hung during init, broken binary, slow MCP adapter, etc.),
      // kill it.  The timer is cancelled permanently on the first turn_start or
      // completed assistant turn, whichever comes first.
      if (startupTimeoutMs > 0) {
        startupTimer = setTimeout(() => {
          if (resolved || receivedFirstEvent) return;
          result.stderr += `\n[pi-subagent] Killed: no JSON output after ${startupTimeoutMs}ms (startup timeout).`;
          try { proc.kill("SIGTERM"); } catch { /* already dead */ }
          setTimeout(() => {
            if (!resolved) {
              try { proc.kill("SIGKILL"); } catch { /* already dead */ }
            }
          }, SIGKILL_TIMEOUT_MS);
        }, startupTimeoutMs);
      }

      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        result.stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        doResolve(code ?? 0);
      });

      proc.on("exit", (code) => {
        // If the process exits, resolve as soon as possible.
        // Give a tiny grace period for any remaining buffered stdout data.
        setTimeout(() => doResolve(code ?? 0), 100);
      });

      proc.on("error", (err) => {
        result.stderr += `Spawn error: ${err.message}`;
        result.stopReason = "error";
        result.errorMessage = `Failed to spawn pi process: ${err.message}`;
        doResolve(1);
      });

      // Abort handling
      if (signal) {
        const kill = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, SIGKILL_TIMEOUT_MS);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
    result.toolCalls = extractToolCalls(result.messages); // populate from parsed messages
    if (wasAborted) {
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
    }

    if (result.exitCode === 0 && endedWithSyntheticResumeFailure(result.messages)) {
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = "Subagent resume failed before the real model continued.";
      if (!result.stderr.trim()) result.stderr = result.errorMessage;
    }

    if (result.exitCode === 0) {
      const nestedErrorSummary = getNestedSubagentErrorSummary(result.messages);
      if (nestedErrorSummary) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.errorMessage = nestedErrorSummary;
        if (!result.stderr.trim()) result.stderr = nestedErrorSummary;
      }
    }

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


// ---------------------------------------------------------------------------
// Parallel execution (subprocess runner).
// ---------------------------------------------------------------------------


export async function executeParallelSubprocess(
  tasks: Array<{ agent: string; task: string; cwd?: string }>,
  agents: AgentConfig[],
  defaultCwd: string,
  parentDepth: number,
  maxDepth: number,
  parentAgentStack: string[],
  preventCycles: boolean,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  resumeResults?: SingleResult[],
  getSessionDir?: (index: number, task: { agent: string; task: string; cwd?: string }) => string | undefined,
  resumeExistingSessions = false,
  sessionRoot?: string,
  fallbackModel?: string,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
}> {
  const maxParallelTasksRaw = process.env[SUBAGENT_MAX_PARALLEL_TASKS_ENV];
  const maxParallelTasksParsed = parseNonNegativeInt(maxParallelTasksRaw);
  if (maxParallelTasksRaw !== undefined && maxParallelTasksParsed === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_PARALLEL_TASKS_ENV}="${maxParallelTasksRaw}". Expected a non-negative integer.`,
    );
  }
  const maxParallelTasks = maxParallelTasksParsed ?? DEFAULT_MAX_PARALLEL_TASKS;

  const maxConcurrencyRaw = process.env[SUBAGENT_MAX_CONCURRENCY_ENV];
  const maxConcurrencyParsed = parseNonNegativeInt(maxConcurrencyRaw);
  if (maxConcurrencyRaw !== undefined && maxConcurrencyParsed === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_CONCURRENCY_ENV}="${maxConcurrencyRaw}". Expected a non-negative integer.`,
    );
  }
  const maxConcurrency = maxConcurrencyParsed ?? DEFAULT_MAX_CONCURRENCY;

  if (tasks.length > maxParallelTasks) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Too many parallel tasks (${tasks.length}). Max is ${maxParallelTasks}.`,
        },
      ],
      details: makeDetails([]),
    };
  }

  const allResults: SingleResult[] = tasks.map((t, index) => resumeResults?.[index] ?? ({
    agent: t.agent,
    agentSource: "unknown" as const,
    task: t.task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    toolCalls: {},
    completedTurns: 0,
    turnInProgress: false,
    liveLog: [],
  }));

  const emitProgress = () => {
    if (!onUpdate) return;
    const running = allResults.filter((r) => r.exitCode === -1).length;
    const done = allResults.filter((r) => r.exitCode !== -1).length;
    onUpdate({
      content: [
        {
          type: "text",
          text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
        },
      ],
      details: makeDetails([...allResults]),
    });
  };

  let heartbeat: NodeJS.Timeout | undefined;
  if (onUpdate) {
    emitProgress();
    heartbeat = setInterval(() => {
      if (allResults.some((r) => r.exitCode === -1)) emitProgress();
    }, PARALLEL_HEARTBEAT_MS);
  }

  let results: SingleResult[];
  try {
    results = await mapConcurrent(tasks, maxConcurrency, async (t, index) => {
      const previousResult = resumeResults?.[index];
      if (previousResult?.exitCode === 0) {
        allResults[index] = previousResult;
        emitProgress();
        return previousResult;
      }
      const savedSessionDir = previousResult?.sessionDir;
      const savedSessionDirExists = sessionDirExists(savedSessionDir);
      const shouldResumeThisSession = resumeExistingSessions && (!previousResult || !savedSessionDir || savedSessionDirExists);
      const sessionDir = shouldResumeThisSession && savedSessionDirExists
        ? savedSessionDir
        : getSessionDir?.(index, t);
      const result = await runAgentSubprocess({
        cwd: defaultCwd,
        agents,
        agentName: t.agent,
        task: t.task,
        taskCwd: t.cwd,
        parentDepth,
        parentAgentStack,
        maxDepth,
        preventCycles,
        signal,
        sessionDir,
        sessionRoot,
        resumeSession: shouldResumeThisSession && !!sessionDir,
        initialResult: previousResult,
        fallbackModel,
        onUpdate: (partial) => {
          if (partial.details?.results[0]) {
            allResults[index] = partial.details.results[0];
            emitProgress();
          }
        },
        makeDetails,
      });
      allResults[index] = result;
      emitProgress();
      return result;
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  const successCount = results.filter((r) => r.exitCode === 0).length;
  const summaries = results.map((r) => {
    const output = getFinalOutput(r.messages);
    return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${output || "(no output)"}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
      },
    ],
    details: makeDetails(results),
  };
}
