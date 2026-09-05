import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { SUBAGENT_PI_COMMAND_ENV, SUBAGENT_PI_ARGS_PREFIX_ENV } from "./constants.js";
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

export function getPiSpawnCommand(override?: { command: string; argsPrefix?: string[] }): {
  command: string;
  argsPrefix: string[];
} {
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

export function stopProcessTree(proc: ChildProcess, force: boolean): void {
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
      try {
        proc.kill(terminationSignal);
      } catch {
        /* already dead */
      }
    }
    return;
  }
  try {
    if (proc.pid) process.kill(-proc.pid, terminationSignal);
    else proc.kill(terminationSignal);
  } catch {
    try {
      proc.kill(terminationSignal);
    } catch {
      /* already dead */
    }
  }
}
