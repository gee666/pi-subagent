import { parseNonNegativeInt } from "../shared.js";

export function configuredNonNegativeInt(name: string, fallback: number, warn = false): number {
  const raw = process.env[name];
  const parsed = parseNonNegativeInt(raw);
  if (warn && raw !== undefined && parsed === null) {
    console.warn(`[pi-subagent] Ignoring invalid ${name}="${raw}". Expected a non-negative integer.`);
  }
  return parsed ?? fallback;
}

export const SIGKILL_TIMEOUT_MS = 5000;
export const RETRY_WAIT_GRACE_MS = 60_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000; // only for startup (before first assistant turn)
export const SUBAGENT_STARTUP_TIMEOUT_ENV = "PI_SUBAGENT_STARTUP_TIMEOUT";
// Once startup succeeds, a child can otherwise remain alive forever if Pi loses
// the next model/RPC turn after a tool result. Bound agent inactivity (not
// repeated progress heartbeats), but never while one of its tools is executing:
// tool runtimes are intentionally unbounded.
export const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60_000;
export const SUBAGENT_IDLE_TIMEOUT_ENV = "PI_SUBAGENT_IDLE_TIMEOUT";
// A startup timeout is almost always a transient cold-start stall (slow cli /
// extension load, momentarily busy box) rather than a deterministic failure, so
// re-spawn a clean child a few times before surfacing the error. This does NOT
// change the per-attempt startup window.
export const DEFAULT_STARTUP_RETRIES = 2;
export const SUBAGENT_STARTUP_RETRIES_ENV = "PI_SUBAGENT_STARTUP_RETRIES";
export const STARTUP_RETRY_BASE_BACKOFF_MS = 1_000;
export const SUBAGENT_PI_COMMAND_ENV = "PI_SUBAGENT_PI_COMMAND";
export const SUBAGENT_PI_ARGS_PREFIX_ENV = "PI_SUBAGENT_PI_ARGS_PREFIX";
export const MAX_CAPTURED_STDERR_CHARS = 64_000;

export const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
export const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
export const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
export const SUBAGENT_FALLBACK_MODEL_ENV = "PI_SUBAGENT_FALLBACK_MODEL";
