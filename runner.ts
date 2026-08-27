/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.js";
import {
  type LiveLogEntry,
  type SingleResult,
  type SubagentDetails,
  type SubagentUsageSummary,
  MAX_LIVE_LOG_ENTRIES,
  emptyUsage,
  extractToolCalls,
  getFinalOutput,
  isResultError,
  isResultSuccess,
  isSubagentDetails,
  isSubagentToolName,
} from "./types.js";
import { SUBAGENT_SESSION_ROOT_ENV } from "./resume.js";
import { SUBAGENT_NAMES_FILE_ENV } from "./names.js";
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
const RETRY_WAIT_GRACE_MS = 60_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000; // only for startup (before first assistant turn)
const SUBAGENT_STARTUP_TIMEOUT_ENV = "PI_SUBAGENT_STARTUP_TIMEOUT";
// Once startup succeeds, a child can otherwise remain alive forever if Pi loses
// the next model/RPC turn after a tool result. Bound agent inactivity (not
// repeated progress heartbeats), but never while one of its tools is executing:
// tool runtimes are intentionally unbounded.
const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60_000;
const SUBAGENT_IDLE_TIMEOUT_ENV = "PI_SUBAGENT_IDLE_TIMEOUT";
// A startup timeout is almost always a transient cold-start stall (slow cli /
// extension load, momentarily busy box) rather than a deterministic failure, so
// re-spawn a clean child a few times before surfacing the error. This does NOT
// change the per-attempt startup window.
const DEFAULT_STARTUP_RETRIES = 2;
const SUBAGENT_STARTUP_RETRIES_ENV = "PI_SUBAGENT_STARTUP_RETRIES";
const STARTUP_RETRY_BASE_BACKOFF_MS = 1_000;
const SUBAGENT_PI_COMMAND_ENV = "PI_SUBAGENT_PI_COMMAND";
const SUBAGENT_PI_ARGS_PREFIX_ENV = "PI_SUBAGENT_PI_ARGS_PREFIX";
const MAX_CAPTURED_STDERR_CHARS = 64_000;

function priorDescendantUsage(result: SingleResult | undefined): SubagentUsageSummary | undefined {
  if (!result) return undefined;
  if (result.priorDescendantUsageSummary) return { ...result.priorDescendantUsageSummary };
  const subtree = result.subtreeUsageSummary;
  if (!subtree) return undefined;
  const own = result.usage ?? emptyUsage();
  const descendants = {
    subagentCount: Math.max(0, subtree.subagentCount - 1),
    inputTokens: Math.max(0, subtree.inputTokens - own.input),
    outputTokens: Math.max(0, subtree.outputTokens - own.output),
    cacheReadTokens: Math.max(0, subtree.cacheReadTokens - own.cacheRead),
    cacheWriteTokens: Math.max(0, subtree.cacheWriteTokens - own.cacheWrite),
    costUsd: Math.max(0, subtree.costUsd - own.cost),
    turns: Math.max(0, subtree.turns - own.turns),
  };
  return descendants.subagentCount > 0 || descendants.inputTokens > 0 || descendants.outputTokens > 0 || descendants.costUsd > 0
    ? descendants
    : undefined;
}

function appendBoundedStderr(result: SingleResult, text: string): void {
  if (!text) return;
  result.stderr += text;
  if (result.stderr.length <= MAX_CAPTURED_STDERR_CHARS) return;
  const omittedNow = result.stderr.length - MAX_CAPTURED_STDERR_CHARS;
  result.stderr = result.stderr.slice(-MAX_CAPTURED_STDERR_CHARS);
  result.stderrTruncatedChars = (result.stderrTruncatedChars ?? 0) + omittedNow;
}

function isProgressOnlyEvent(line: string, result: SingleResult): boolean {
  try {
    const event = JSON.parse(line);
    if (event?.type !== "subagent_progress") return false;
  } catch {
    return false;
  }
  return processJsonLine(line, result);
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

export interface RunningSubagentHandle {
  steer(message: string): void;
}

export type RunningSubagentStartedCallback = (handle: RunningSubagentHandle) => void;

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

export interface RuntimeLaunchCommand {
  command: string;
  argsPrefix: string[];
}

/**
 * Re-launch the runtime and entrypoint that are executing this Pi process.
 *
 * This deliberately knows nothing about npm, pnpm, Pi package names, or dist
 * layouts. With Node it becomes `node <entrypoint>`; with Bun it becomes
 * `bun <entrypoint>`. Package-manager shims have already done their job before
 * the current process starts, so children do not need to execute or parse them.
 */
export function getCurrentRuntimeLaunch(
  argv: readonly string[] = process.argv,
  execPath = process.execPath,
): RuntimeLaunchCommand | null {
  const rawEntrypoint = argv[1];
  if (!execPath || !rawEntrypoint || rawEntrypoint.startsWith("-")) return null;
  const entrypoint = path.resolve(rawEntrypoint);
  try {
    if (!fs.statSync(entrypoint).isFile()) return null;
  } catch {
    return null;
  }
  return { command: execPath, argsPrefix: [entrypoint] };
}

function getPiSpawnCommand(override?: { command: string; argsPrefix?: string[] }): { command: string; argsPrefix: string[] } {
  if (override?.command) return { command: override.command, argsPrefix: override.argsPrefix ?? [] };

  const overrideCommand = process.env[SUBAGENT_PI_COMMAND_ENV];
  if (overrideCommand) {
    let argsPrefix: string[] = [];
    const rawPrefix = process.env[SUBAGENT_PI_ARGS_PREFIX_ENV];
    if (rawPrefix) {
      try {
        const parsed = JSON.parse(rawPrefix);
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
          argsPrefix = parsed;
        }
      } catch {
        // Ignore invalid test/debug override and run the command without a prefix.
      }
    }
    return { command: overrideCommand, argsPrefix };
  }

  const currentRuntime = getCurrentRuntimeLaunch();
  if (currentRuntime) return currentRuntime;

  // SDK/embedded hosts may have no script entrypoint. They can set the
  // explicit command variables above; keep `pi` as a final conventional
  // fallback for environments where it is a real executable on PATH.
  return { command: "pi", argsPrefix: [] };
}

/**
 * Build a child environment with a dependable executable search path.
 *
 * Elevated PowerShell sessions and pnpm shims can start Pi with a PATH that
 * omits PNPM_HOME, the user npm bin directory, or even the Node directory.
 * Child Pi processes then start (when we resolved cli.js directly) but cannot
 * launch tools or nested Pi processes. Windows also treats Path/PATH keys
 * case-insensitively, while Node's env object does not, so emit exactly one.
 */
export function buildChildProcessEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = { ...process.env, ...extra };
  const pathEntries: string[] = [];
  const add = (value: string | undefined) => {
    if (!value) return;
    for (const entry of value.split(path.delimiter)) {
      const clean = entry.trim();
      if (!clean) continue;
      const key = process.platform === "win32" ? clean.toLowerCase() : clean;
      if (!pathEntries.some((existing) => (process.platform === "win32" ? existing.toLowerCase() : existing) === key)) {
        pathEntries.push(clean);
      }
    }
  };

  for (const [key, value] of Object.entries(inherited)) {
    if (key.toLowerCase() === "path") add(value);
  }
  add(path.dirname(process.execPath));
  add(process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : undefined);
  add(inherited.PNPM_HOME);
  add(inherited.npm_config_prefix);
  if (inherited.npm_config_prefix) add(path.join(inherited.npm_config_prefix, "bin"));
  if (process.platform === "win32") {
    add(inherited.APPDATA ? path.join(inherited.APPDATA, "npm") : undefined);
    add(inherited.LOCALAPPDATA ? path.join(inherited.LOCALAPPDATA, "pnpm") : undefined);
    add(inherited.USERPROFILE ? path.join(inherited.USERPROFILE, "AppData", "Local", "pnpm") : undefined);
    const systemRoot = inherited.SystemRoot ?? inherited.SYSTEMROOT;
    add(systemRoot ? path.join(systemRoot, "System32") : undefined);
  }

  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (key.toLowerCase() !== "path") env[key] = value;
  }
  env[process.platform === "win32" ? "Path" : "PATH"] = pathEntries.join(path.delimiter);
  return env;
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
  if (entry.at === undefined) entry.at = Date.now();
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

  const semanticEventTypes = new Set([
    "message_end", "tool_result_end", "subagent_progress", "turn_start",
    "turn_end", "tool_execution_start", "tool_execution_end",
  ]);
  if (semanticEventTypes.has(event.type)) {
    result.lastActionAt = typeof event.timestamp === "number" ? event.timestamp : Date.now();
  }

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
      if (msg.stopReason) {
        result.stopReason = msg.stopReason;
        // A later successful retry supersedes the prior transport error. Keep
        // only the error attached to the latest terminal assistant message.
        result.errorMessage = msg.errorMessage || undefined;
      }
    }
    return true;
  }

  if (event.type === "tool_result_end" && event.message) {
    const msg = event.message as Message;
    if (!hasMessage(result, msg)) result.messages.push(msg);
    if (isSubagentToolName((msg as any).toolName) && typeof (msg as any).toolCallId === "string") {
      delete result.liveNestedSubagents?.[(msg as any).toolCallId];
    }
    return true;
  }

  if (event.type === "subagent_progress") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
    if (toolCallId && isSubagentDetails(event.details)) {
      result.liveNestedSubagents ??= {};
      result.liveNestedSubagents[toolCallId] = event.details;
      return true;
    }
    return false;
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

export function resolveSubagentModel(agentModel?: string, currentParentModel?: string): string | undefined {
  // The active parent model is authoritative. Agent frontmatter is retained as
  // a compatibility fallback only for callers that cannot supply live context.
  return currentParentModel ?? agentModel ?? process.env[SUBAGENT_FALLBACK_MODEL_ENV] ?? _inheritedCliArgs.fallbackModel;
}

function buildPiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  task: string,
  sessionDir: string | undefined,
  resumeSession: boolean,
  fallbackModelOverride?: string,
  rawPrompt = false,
): { args: string[]; prompt: string } {
  const args: string[] = [
    "--mode",
    "rpc",
    ..._inheritedCliArgs.extensionArgs,
    ..._inheritedCliArgs.alwaysProxy,
  ];

  if (sessionDir) args.push("--session-dir", sessionDir);
  if (resumeSession) args.push("--continue");

  // Always use the model active in the parent at launch time. This matters
  // when /model changed after the parent process originally started.
  const model = resolveSubagentModel(agent.model, fallbackModelOverride);
  if (model) args.push("--model", model);

  const thinking = agent.thinking ?? _inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  // agent.tools is set only when the agent file specifies tools (length > 0)
  if (agent.tools && agent.tools.length > 0) {
    // Always include the delegation tools so children can re-delegate and
    // resume when depth allows. The child extension only registers them when
    // canDelegate is true, so listing them here is harmless otherwise.
    const toolsWithSubagent = [...agent.tools];
    for (const tool of ["subagents", "resume_subagents"]) {
      if (!toolsWithSubagent.includes(tool)) toolsWithSubagent.push(tool);
    }
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
  return {
    args,
    prompt: rawPrompt
      ? task
      : resumeSession
        ? `Continue the previous task from where you left off. Original task: ${task}`
        : `Task: ${task}`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Working directory inherited by every subagent process. */
  cwd: string;
  /** All available agent configs. */
  agents: AgentConfig[];
  /** Name of the agent to run. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Unique resumable human name assigned to this subagent (e.g. "John"). */
  subagentName?: string;
  /** When true, send the task text to the child verbatim (no "Task:" / resume preamble). */
  rawPrompt?: boolean;
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
  /** Factory to wrap results into durable SubagentDetails. Optional .live keeps transient TUI state. */
  makeDetails: ((results: SingleResult[]) => SubagentDetails) & { live?: (results: SingleResult[]) => SubagentDetails };
  /** Dedicated session directory for this subagent process. */
  sessionDir?: string;
  /** Top-level root for all subagent session directories in this delegation tree. */
  sessionRoot?: string;
  /**
   * Shared name-registry file for this delegation tree, passed to the child
   * via its spawn environment. Deliberately NOT set on process.env of the
   * parent itself: pi reloads extension modules on session switches, and a
   * self-set env var would then masquerade as "inherited from a parent".
   */
  namesFile?: string;
  /** Continue the most recent session in sessionDir instead of creating a new one. */
  resumeSession?: boolean;
  /** Previously captured state for this same subagent, used to render resumed nested trees. */
  initialResult?: SingleResult;
  /** Fallback model to use when the agent config does not pin one. */
  fallbackModel?: string;
  /** Test/debug override for the spawned pi executable. */
  piCommandOverride?: { command: string; argsPrefix?: string[] };
  /** Test/debug override for startup timeout. */
  startupTimeoutMsOverride?: number;
  /** Test/debug override for post-startup semantic inactivity timeout. */
  idleTimeoutMsOverride?: number;
  /** Test/debug override for graceful-stop to SIGKILL escalation. */
  terminationTimeoutMsOverride?: number;
  /** Called once the child RPC process is ready to receive steering messages. */
  onHandle?: RunningSubagentStartedCallback;
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
    piCommandOverride,
    startupTimeoutMsOverride,
    idleTimeoutMsOverride,
    terminationTimeoutMsOverride,
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
    const { args: piArgs, prompt } = buildPiArgs(
      agent,
      promptTmpPath,
      task,
      sessionDir,
      shouldContinueSession,
      fallbackModel,
      opts.rawPrompt === true,
    );
    let wasAborted = false;
    const startupRetries = (() => {
      const raw = process.env[SUBAGENT_STARTUP_RETRIES_ENV];
      const parsed = parseNonNegativeInt(raw);
      return parsed !== null ? parsed : DEFAULT_STARTUP_RETRIES;
    })();
    let startupTimedOut = false;
    let exitCode = -1;

    for (let attempt = 0; ; attempt++) {
      startupTimedOut = false;
      exitCode = await new Promise<number>((resolve) => {
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
          ...(fallbackModel ? { [SUBAGENT_FALLBACK_MODEL_ENV]: fallbackModel } : {}),
          // All other provider/auth/proxy/temp/home variables are inherited.
          // PI_OFFLINE is NOT forced here — see explanation near PI_OFFLINE_ENV.
        }),
      });

      let buffer = "";
      const stdoutDecoder = new StringDecoder("utf8");
      let resolved = false;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let receivedFirstEvent = false;
      let agentSettled = false;
      let forcedExitCode: number | undefined;
      let lastNestedProgressSignature: string | undefined;
      // Track only tool calls from this process attempt. Persisted live render
      // state may contain a tool that was interrupted before a resume and must
      // not disable the new process's watchdog forever.
      const activeToolCallIds = new Set<string>();
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
      const startupTimeoutMs = (() => {
        if (startupTimeoutMsOverride !== undefined) return startupTimeoutMsOverride;
        const raw = process.env[SUBAGENT_STARTUP_TIMEOUT_ENV];
        if (raw === undefined) return DEFAULT_STARTUP_TIMEOUT_MS;
        const parsed = parseNonNegativeInt(raw);
        return parsed !== null ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
      })();

      const doResolve = (code: number) => {
        if (resolved) return;
        resolved = true;
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
        if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        resolve(code);
      };

      const stopChild = (force: boolean) => {
        const terminationSignal = force ? "SIGKILL" : "SIGTERM";
        if (process.platform === "win32" && proc.pid) {
          // proc.kill() only terminates the immediate Node process on Windows;
          // /T is required to avoid orphaning nested agents and tool children.
          try {
            const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
            const killer = spawn(
              path.join(systemRoot, "System32", "taskkill.exe"),
              // taskkill has no reliable graceful console-process mode when
              // launched from elevated PowerShell; without /F it often leaves
              // the Node child alive until our five-second escalation timer.
              ["/PID", String(proc.pid), "/T", "/F"],
              { shell: false, stdio: "ignore", windowsHide: true },
            );
            killer.unref();
          } catch {
            try { proc.kill(terminationSignal); } catch { /* already dead */ }
          }
          return;
        }
        try {
          if (proc.pid) process.kill(-proc.pid, terminationSignal);
          else proc.kill(terminationSignal);
        } catch {
          try { proc.kill(terminationSignal); } catch { /* already dead */ }
        }
      };

      const forceStopAndSettle = (settleCode = forcedExitCode ?? 1) => {
        stopChild(false);
        if (killTimer) clearTimeout(killTimer);
        killTimer = setTimeout(() => {
          if (resolved) return;
          stopChild(true);
          // Never depend exclusively on a close event from a wedged child.
          proc.stdin?.destroy();
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          proc.unref();
          doResolve(settleCode);
        }, terminationTimeoutMsOverride ?? SIGKILL_TIMEOUT_MS);
      };

      const idleTimeoutMs = (() => {
        if (idleTimeoutMsOverride !== undefined) return Math.max(0, idleTimeoutMsOverride);
        const raw = process.env[SUBAGENT_IDLE_TIMEOUT_ENV];
        if (raw === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
        const parsed = parseNonNegativeInt(raw);
        return parsed !== null ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
      })();

      const noteSemanticActivity = (minimumQuietPeriodMs = 0) => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
        if (!receivedFirstEvent || idleTimeoutMs === 0 || resolved) return;
        // The idle timeout measures the agent itself, not tools it has invoked.
        // A tool may legitimately be silent for longer than the configured
        // timeout, so leave the watchdog disarmed until every concurrent tool
        // execution has ended. tool_execution_end will call this again and
        // start a fresh full inactivity window.
        if (activeToolCallIds.size > 0) return;
        const quietPeriodMs = Math.max(idleTimeoutMs, minimumQuietPeriodMs);
        idleTimer = setTimeout(() => {
          if (resolved) return;
          const message = `Subagent inactivity timeout: no agent activity for ${quietPeriodMs}ms.`;
          forcedExitCode = 1;
          result.stopReason = "error";
          result.errorMessage = message;
          appendBoundedStderr(result, `\n[pi-subagent] Killed: ${message}`);
          emitUpdate();
          forceStopAndSettle();
        }, quietPeriodMs);
      };

      const flushLine = (line: string) => {
        let event: any;
        try { event = JSON.parse(line); } catch { event = null; }

        if (event?.type === "tool_execution_start" && typeof event.toolCallId === "string") {
          activeToolCallIds.add(event.toolCallId);
        } else if (event?.type === "tool_execution_end" && typeof event.toolCallId === "string") {
          activeToolCallIds.delete(event.toolCallId);
        }

        if (
          event?.type === "response" &&
          event.id === promptRequestId &&
          event.command === "prompt"
        ) {
          if (event.success !== true) {
            const message = `Subagent prompt rejected: ${typeof event.error === "string" ? event.error : "unknown RPC error"}`;
            forcedExitCode = 1;
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
          noteSemanticActivity(
            event.willRetry === true ? RETRY_WAIT_GRACE_MS : 0,
          );
          return;
        }

        if (event?.type === "agent_settled") {
          agentSettled = true;
          result.lastActionAt = Date.now();
          // No semantic watchdog may fire while we are only waiting for the
          // deliberately terminated RPC process tree to close. On slower
          // launchers (notably Windows taskkill), that cleanup can outlast a
          // short idle timeout and overwrite a successful settled result.
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
          if (result.stopReason === "length" && !result.errorMessage) {
            result.errorMessage = "Subagent output was incomplete because the model reached its output limit.";
          }
          const settledCode = forcedExitCode ?? (isResultError({ ...result, exitCode: 0 }) ? 1 : 0);
          // RPC mode remains alive waiting for more commands. Terminate its
          // process tree, but do not report completion until close (or bounded
          // SIGKILL escalation) confirms it stopped.
          forceStopAndSettle(settledCode);
          return;
        }

        const accepted = processJsonLine(line, result);
        if (accepted) {
          // Cancel the startup timer as soon as the subprocess proves it has
          // reached the LLM-call phase. Two conditions qualify:
          //   1. A turn has started (turn_start sets turnInProgress=true).
          //   2. A complete assistant turn has arrived (turns > 0).
          if (!receivedFirstEvent && (result.usage.turns > 0 || result.turnInProgress)) {
            receivedFirstEvent = true;
            if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
          }
          // Parallel progress is emitted every second even when nothing changed.
          // Only a changed nested snapshot counts as activity, otherwise a dead
          // grandchild could keep every ancestor alive forever.
          let semanticActivity = true;
          if (event?.type === "subagent_progress") {
            let signature: string;
            try { signature = JSON.stringify(event.details); } catch { signature = "unserializable"; }
            semanticActivity = signature !== lastNestedProgressSignature;
            lastNestedProgressSignature = signature;
          }
          if (semanticActivity) noteSemanticActivity();
          emitUpdate();
        } else if (receivedFirstEvent) {
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

      // Start the startup timer — if the child process never reaches the
      // LLM-call phase (hung during init, broken binary, slow MCP adapter, etc.),
      // kill it. The idle watchdog replaces it after the first turn_start or
      // completed assistant turn.
      if (startupTimeoutMs > 0) {
        startupTimer = setTimeout(() => {
          if (resolved || receivedFirstEvent) return;
          startupTimedOut = true;
          const message = `Subagent startup timeout: no model turn after ${startupTimeoutMs}ms.`;
          forcedExitCode = 1;
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
        if (forcedExitCode !== undefined) return forcedExitCode;
        // Once Pi emitted agent_settled, the semantic run is complete and this
        // runner deliberately terminates the still-listening RPC process. Some
        // launchers translate that expected SIGTERM into exit code 143 rather
        // than reporting a signal. Do not turn our own cleanup status into a
        // failed subagent; only the settled model result determines success.
        if (agentSettled) return isResultError({ ...result, exitCode: 0 }) ? 1 : 0;

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
        if (!resolved) doResolve(classifyUnexpectedExit(code, exitSignal));
      });

      proc.on("exit", (code, exitSignal) => {
        if (resolved) return;
        // `close` waits for stdio. A descendant can inherit stdout and keep it
        // open after the immediate Pi process exits, so bound that drain while
        // still allowing normal buffered JSONL to arrive before settlement.
        forceStopAndSettle(classifyUnexpectedExit(code, exitSignal));
      });

      proc.stdin?.on("error", (err) => {
        if (resolved) return;
        forcedExitCode = 1;
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
          wasAborted = true;
          forcedExitCode = 130;
          forceStopAndSettle();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }

      if (!wasAborted && !resolved && !sendRpc({ id: promptRequestId, type: "prompt", message: prompt })) {
        forcedExitCode = 1;
        result.stopReason = "error";
        result.errorMessage = "Failed to write the initial prompt to the subagent RPC process.";
        forceStopAndSettle(1);
      }
      });

      const noProgress = result.messages.length <= initialMessageCount;
      const canRetry =
        startupTimedOut && !wasAborted && noProgress && attempt < startupRetries;
      if (!canRetry) break;

      // Transient cold-start stall: clear the error markers the startup timer
      // set on `result`, then re-spawn a clean child. The per-attempt startup
      // window is unchanged; we just give the child another chance to boot.
      result.exitCode = -1;
      result.stopReason = undefined;
      result.errorMessage = undefined;
      appendBoundedStderr(result, `\n[pi-subagent] Startup timeout; retrying (attempt ${attempt + 2}/${startupRetries + 1}).`);
      emitUpdate();
      await new Promise<void>((resolve) =>
        setTimeout(resolve, STARTUP_RETRY_BASE_BACKOFF_MS * (attempt + 1)),
      );
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
      result.errorMessage = "Subagent resume made no progress: resumed subprocess exited without producing any new messages.";
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


// ---------------------------------------------------------------------------
// Parallel execution (subprocess runner).
// ---------------------------------------------------------------------------


export async function executeParallelSubprocess(
  tasks: Array<{ agent: string; task: string }>,
  agents: AgentConfig[],
  defaultCwd: string,
  parentDepth: number,
  maxDepth: number,
  parentAgentStack: string[],
  preventCycles: boolean,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: ((results: SingleResult[]) => SubagentDetails) & { live?: (results: SingleResult[]) => SubagentDetails },
  resumeResults?: SingleResult[],
  getSessionDir?: (index: number, task: { agent: string; task: string }) => string | undefined,
  resumeExistingSessions = false,
  sessionRoot?: string,
  fallbackModel?: string,
  onHandleForTask?: (index: number, task: { agent: string; task: string }, handle: RunningSubagentHandle) => void,
  onTaskDone?: (index: number, task: { agent: string; task: string }) => void,
  extras?: {
    /** Per-task resumable names (aligned with tasks by index). */
    names?: Array<string | undefined>;
    /** Send each task text to the child verbatim (resume_subagents flow). */
    rawPrompts?: boolean;
    /** Shared name-registry file passed to children via spawn env. */
    namesFile?: string;
  },
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
  isError?: boolean;
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
      isError: true,
    };
  }

  const allResults: SingleResult[] = tasks.map((t, index) => resumeResults?.[index] ?? ({
    agent: t.agent,
    agentSource: "unknown" as const,
    task: t.task,
    name: extras?.names?.[index],
    startedAt: Date.now(),
    lastActionAt: Date.now(),
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
      details: (makeDetails.live ?? makeDetails)([...allResults]),
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
      if (previousResult && isResultSuccess(previousResult)) {
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
      let result: SingleResult;
      try {
        result = await runAgentSubprocess({
          cwd: defaultCwd,
          agents,
          agentName: t.agent,
          task: t.task,
          subagentName: extras?.names?.[index],
          rawPrompt: extras?.rawPrompts === true,
          namesFile: extras?.namesFile,
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
          onHandle: (handle) => onHandleForTask?.(index, t, handle),
          onUpdate: (partial) => {
            if (partial.details?.results[0]) {
              allResults[index] = partial.details.results[0];
              emitProgress();
            }
          },
          makeDetails,
        });
      } finally {
        onTaskDone?.(index, t);
      }
      allResults[index] = result;
      emitProgress();
      return result;
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  const successCount = results.filter(isResultSuccess).length;
  const summaries = results.map((r) => {
    const succeeded = isResultSuccess(r);
    const output = succeeded
      ? getFinalOutput(r.messages, r.finalOutput)
      : r.errorMessage || r.stderr || getFinalOutput(r.messages, r.finalOutput);
    const identity = r.name ? `${r.name} (${r.agent})` : r.agent;
    const status = succeeded ? "completed" : r.exitCode === -1 ? "unfinished" : "failed";
    return `[${identity}] ${status}: ${output || "(no output)"}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
      },
    ],
    details: makeDetails(results),
    ...(successCount === results.length ? {} : { isError: true }),
  };
}
