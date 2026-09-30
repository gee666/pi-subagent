import * as fs from "node:fs";
import * as path from "node:path";
import { latestSessionFile } from "../storage/session-fork.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../storage/values.js";

export interface SessionTarget {
  cwd: string;
  sessionDir: string | undefined;
  /** null pins the absence of a transcript, so argument building must not rediscover one. */
  sessionFile: string | null;
}

/** Select once, before asynchronous resource discovery, and use this target throughout the launch. */
export function resolveSessionTarget(
  callerCwd: string,
  sessionDir: string | undefined,
  resumeSession: boolean,
  namedResume = false,
): SessionTarget {
  const target: SessionTarget = {
    cwd: path.resolve(callerCwd),
    sessionDir: sessionDir ? path.resolve(callerCwd, sessionDir) : undefined,
    sessionFile: null,
  };
  if (!resumeSession && !namedResume) return target;
  target.sessionFile = target.sessionDir ? (latestSessionFile(target.sessionDir) ?? null) : null;
  if (!target.sessionFile) {
    if (namedResume)
      throw new Error(`Cannot resume named subagent: no saved session file in ${sessionDir ?? "(missing directory)"}.`);
    return target;
  }
  // Like Pi's header scan, skip blank/malformed lines but require the first parsed entry to be a header.
  let header: unknown;
  for (const line of fs.readFileSync(target.sessionFile, "utf8").split("\n")) {
    try {
      header = JSON.parse(line);
    } catch {
      continue;
    }
    if (header) break;
  }
  if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string")
    throw new Error(`Cannot resume subagent: invalid saved session header in ${target.sessionFile}.`);
  if (header.cwd !== undefined && typeof header.cwd !== "string")
    throw new Error(`Cannot resume subagent: invalid saved working directory in ${target.sessionFile}.`);
  // Pi-created headers store native absolute paths. Reject ambiguous manually edited paths rather
  // than approving one cwd while Pi interprets another. Legacy headers without cwd inherit the caller.
  if (typeof header.cwd === "string" && header.cwd) {
    if (!path.isAbsolute(header.cwd))
      throw new Error(`Cannot resume subagent: saved working directory must be absolute in ${target.sessionFile}.`);
    // Reuse Pi's normalization, including Windows shell paths; this does not open or mutate a session.
    target.cwd = SessionManager.inMemory(header.cwd).getCwd();
  }
  if (!fs.statSync(target.cwd).isDirectory())
    throw new Error(`Cannot resume subagent: saved working directory is not a directory: ${target.cwd}.`);
  return target;
}
