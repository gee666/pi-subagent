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
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  emptyUsage,
  extractToolCalls,
  getFinalOutput,
  getNestedSubagentErrorSummary,
} from "./types.js";

const SIGKILL_TIMEOUT_MS = 5000;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const PI_OFFLINE_ENV = "PI_OFFLINE";

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

function writeForkSessionToTempFile(
  agentName: string,
  sessionJsonl: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `fork-${safeName}.jsonl`);
  fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
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
      "--provider", "--api-key", "--system-prompt", "--session-dir",
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

function processJsonLine(line: string, result: SingleResult): boolean {
  if (!line.trim()) return false;

  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  if (event.type === "message_end" && event.message) {
    const msg = event.message as Message;
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
      if (!result.model && msg.model) result.model = msg.model;
      if (msg.stopReason) result.stopReason = msg.stopReason;
      if (msg.errorMessage) result.errorMessage = msg.errorMessage;
    }
    return true;
  }

  if (event.type === "tool_result_end" && event.message) {
    result.messages.push(event.message as Message);
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
  delegationMode: DelegationMode,
  forkSessionPath: string | null,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ..._inheritedCliArgs.extensionArgs,
    ..._inheritedCliArgs.alwaysProxy,
    "-p",
  ];

  if (delegationMode === "spawn") {
    args.push("--no-session");
  } else if (forkSessionPath) {
    args.push("--session", forkSessionPath);
  }

  // Agent config takes priority; fall back to parent CLI value
  const model = agent.model ?? _inheritedCliArgs.fallbackModel;
  if (model) args.push("--model", model);

  const thinking = agent.thinking ?? _inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  // agent.tools is set only when the agent file specifies tools (length > 0)
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  } else if (agent.tools === undefined) {
    // Agent didn't restrict tools — inherit parent's preference
    if (_inheritedCliArgs.fallbackTools !== undefined) {
      args.push("--tools", _inheritedCliArgs.fallbackTools);
    } else if (_inheritedCliArgs.fallbackNoTools) {
      args.push("--no-tools");
    }
  }

  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  args.push(`Task: ${task}`);
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
  /** Context mode: spawn (fresh) or fork (session snapshot + task). */
  delegationMode: DelegationMode;
  /** Serialized parent session snapshot used when delegationMode is "fork". */
  forkSessionSnapshotJsonl?: string;
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
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agents,
    agentName,
    task,
    taskCwd,
    delegationMode,
    forkSessionSnapshotJsonl,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    signal,
    onUpdate,
    makeDetails,
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
    };
  }

  if (
    delegationMode === "fork" &&
    (!forkSessionSnapshotJsonl || !forkSessionSnapshotJsonl.trim())
  ) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr:
        "Cannot run in fork mode: missing parent session snapshot context.",
      usage: emptyUsage(),
      toolCalls: {},
      model: agent.model,
      stopReason: "error",
      errorMessage:
        "Cannot run in fork mode: missing parent session snapshot context.",
    };
  }

  const result: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    toolCalls: {},
    model: agent.model,
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

  // Write forked session snapshot if needed
  let forkSessionTmpDir: string | null = null;
  let forkSessionTmpPath: string | null = null;
  if (delegationMode === "fork" && forkSessionSnapshotJsonl) {
    const tmp = writeForkSessionToTempFile(agent.name, forkSessionSnapshotJsonl);
    forkSessionTmpDir = tmp.dir;
    forkSessionTmpPath = tmp.filePath;
  }

  try {
    const piArgs = buildPiArgs(
      agent,
      promptTmpPath,
      task,
      delegationMode,
      forkSessionTmpPath,
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
      const spawnCmd = process.platform === "win32" ? process.execPath : "pi";
      const spawnArgs = process.platform === "win32" ? [process.argv[1], ...piArgs] : piArgs;
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
          [PI_OFFLINE_ENV]: "1",
        },
      });

      let buffer = "";

      const flushLine = (line: string) => {
        if (processJsonLine(line, result)) emitUpdate();
      };

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
        if (buffer.trim()) flushLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

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
  } finally {
    cleanupTempDir(promptTmpDir);
    cleanupTempDir(forkSessionTmpDir);
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 */
export async function mapConcurrent<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
