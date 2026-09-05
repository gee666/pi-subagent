import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "./values.js";

const LOCK_RETRY_INTERVAL_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 15_000;

function lockDirFor(file: string): string {
  return `${file}.lock`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireNamesLock(file: string): Promise<() => void> {
  const lockDir = lockDirFor(file);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      return () => {
        try {
          fs.rmdirSync(lockDir);
        } catch {
          /* already released or stolen as stale */
        }
      };
    } catch (err) {
      // Anything but "already exists" is a persistent FS problem (permissions,
      // a file squatting on the lock path, read-only FS, ...). Retrying would
      // spin forever, so surface it.
      if (!isRecord(err) || err.code !== "EEXIST") {
        throw new Error(
          `Cannot create subagent name registry lock ${lockDir}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Recover stale locks left behind by crashed processes. The steal is an
    // atomic rename to a unique graveyard path so concurrent stealers cannot
    // both "win"; after the rename we re-verify staleness — if we raced and
    // grabbed a *fresh* lock that replaced the stale one, we put it back.
    try {
      const stat = fs.statSync(lockDir);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        const graveyard = `${lockDir}.stale-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        try {
          fs.renameSync(lockDir, graveyard);
          const stolen = fs.statSync(graveyard);
          if (Date.now() - stolen.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(graveyard, { recursive: true, force: true });
          } else {
            try {
              fs.renameSync(graveyard, lockDir);
            } catch {
              fs.rmSync(graveyard, { recursive: true, force: true });
            }
          }
        } catch {
          /* another stealer won the rename; fall through to retry */
        }
      }
    } catch {
      /* lock vanished between mkdir failure and stat; retry */
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for subagent name registry lock: ${lockDir}`);
    }
    await sleep(LOCK_RETRY_INTERVAL_MS);
  }
}
