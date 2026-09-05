import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../agents.js";
import { SUBAGENT_FALLBACK_MODEL_ENV } from "./constants.js";
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
    if (!raw.startsWith("-")) {
      i++;
      continue;
    }

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
    if (["--mode", "--session", "--append-system-prompt", "--export", "--subagent-max-depth"].includes(flagName)) {
      const [, skip] = getVal();
      i += skip;
      continue;
    }

    // --subagent-prevent-cycles takes an optional value
    if (flagName === "--subagent-prevent-cycles") {
      if (inlineValue !== undefined || nextIsValue) {
        i += inlineValue !== undefined ? 1 : 2;
      } else {
        i++;
      }
      continue;
    }

    // --list-models has an optional search term
    if (flagName === "--list-models") {
      if (inlineValue !== undefined || nextIsValue) {
        i += inlineValue !== undefined ? 1 : 2;
      } else {
        i++;
      }
      continue;
    }

    // ── BLOCKED: boolean flags ────────────────────────────────────────────────
    if (
      [
        "--print",
        "-p",
        "--no-session",
        "--continue",
        "-c",
        "--resume",
        "-r",
        "--offline",
        "--help",
        "-h",
        "--version",
        "-v",
        "--no-subagent-prevent-cycles",
      ].includes(flagName)
    ) {
      i++;
      continue;
    }

    // ── EXTENSION FLAGS: handled separately with path resolution ─────────────
    if (flagName === "--no-extensions" || flagName === "-ne") {
      extensionArgs.push(flagName);
      i++;
      continue;
    }
    if (flagName === "--extension" || flagName === "-e") {
      const [value, skip] = getVal();
      if (value !== undefined) extensionArgs.push(flagName, resolveExtensionArg(value));
      i += skip;
      continue;
    }

    // ── ALWAYS-PROXY: known value flags ──────────────────────────────────────
    if (
      ["--provider", "--api-key", "--system-prompt", "--models", "--skill", "--prompt-template", "--theme"].includes(
        flagName,
      )
    ) {
      const [value, skip] = getVal();
      if (value !== undefined) alwaysProxy.push(flagName, value);
      i += skip;
      continue;
    }

    // ── ALWAYS-PROXY: known boolean flags ────────────────────────────────────
    if (["--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes", "--verbose"].includes(flagName)) {
      alwaysProxy.push(flagName);
      i++;
      continue;
    }

    // ── FALLBACK: agent config may override ───────────────────────────────────
    if (flagName === "--model") {
      const [value, skip] = getVal();
      if (value !== undefined) fallbackModel = value;
      i += skip;
      continue;
    }
    if (flagName === "--thinking") {
      const [value, skip] = getVal();
      if (value !== undefined) fallbackThinking = value;
      i += skip;
      continue;
    }
    if (flagName === "--tools") {
      const [value, skip] = getVal();
      if (value !== undefined) fallbackTools = value;
      i += skip;
      continue;
    }
    if (flagName === "--no-tools") {
      fallbackNoTools = true;
      i++;
      continue;
    }

    // ── UNKNOWN: heuristic passthrough ───────────────────────────────────────
    // Likely a custom extension flag. Forward with value if next token looks like one.
    if (inlineValue !== undefined) {
      alwaysProxy.push(flagName, inlineValue);
      i++;
      continue;
    }
    if (nextIsValue) {
      alwaysProxy.push(flagName, nextToken);
      i += 2;
      continue;
    }
    alwaysProxy.push(flagName);
    i++;
  }

  return { extensionArgs, alwaysProxy, fallbackModel, fallbackThinking, fallbackTools, fallbackNoTools };
}

/** Cached once — process.argv is immutable at runtime */
const _inheritedCliArgs = parseInheritedCliArgs(process.argv);

export function resolveSubagentModel(agentModel?: string, currentParentModel?: string): string | undefined {
  // The active parent model is authoritative. Agent frontmatter is retained as
  // a compatibility fallback only for callers that cannot supply live context.
  return (
    currentParentModel ?? agentModel ?? process.env[SUBAGENT_FALLBACK_MODEL_ENV] ?? _inheritedCliArgs.fallbackModel
  );
}

export function buildPiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  task: string,
  sessionDir: string | undefined,
  resumeSession: boolean,
  fallbackModelOverride?: string,
  rawPrompt = false,
): { args: string[]; prompt: string } {
  const args: string[] = ["--mode", "rpc", ..._inheritedCliArgs.extensionArgs, ..._inheritedCliArgs.alwaysProxy];

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
