import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { decodeState, type TreeConcurrencyState } from "./tree-concurrency-state.js";

/** Missing/corrupt data must block admission, never silently reset the cap. */
export function readLedger(directory: string): { revision: number; state: TreeConcurrencyState } {
  try {
    let revision = -1;
    for (const name of fs.readdirSync(directory)) {
      const match = /^state-(\d+)\.json$/.exec(name);
      if (match) revision = Math.max(revision, Number(match[1]));
    }
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("No committed state");
    return {
      revision,
      state: decodeState(JSON.parse(fs.readFileSync(path.join(directory, `state-${revision}.json`), "utf8"))),
    };
  } catch (error) {
    throw new Error(`Cannot read global tree concurrency at ${directory}; launches blocked: ${String(error)}`);
  }
}

/**
 * Atomic hard-link publication is the compare-and-swap. Dead writers leave only
 * an unused candidate, never a held lock. Keep revisions to prevent ABA races.
 */
export function commitLedger(directory: string, revision: number, state: TreeConcurrencyState): boolean {
  const temporaryDirectory = path.join(directory, "tmp");
  fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  const candidate = path.join(temporaryDirectory, `${process.pid}-${randomUUID()}.json`);
  const fd = fs.openSync(candidate, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(candidate, path.join(directory, `state-${revision}.json`));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}
