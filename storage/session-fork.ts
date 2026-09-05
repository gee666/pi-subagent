import * as fs from "node:fs";
import * as path from "node:path";
import { SUBAGENT_NAMES_CUSTOM_TYPE } from "./names-identity.js";
import { isRecord } from "./values.js";

function latestSessionFile(sessionDir: string): string | undefined {
  try {
    const entries = fs
      .readdirSync(sessionDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const file = path.join(sessionDir, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries[0]?.file;
  } catch {
    return undefined;
  }
}

/**
 * Fork a subagent session by copying its newest session file into a new
 * directory.
 *
 * The copy is rewritten so the fork is a distinct session:
 *   - the session header id gets a `-fork-...` suffix
 *   - persisted names-identity entries get a fresh ownerId, so the forked
 *     subagent does not inherit the original's ownership of ITS OWN nested
 *     subagents (its resumes of those names fork too, instead of polluting
 *     the originals).
 */
export function forkSessionInto(originalSessionDir: string, forkSessionDir: string): boolean {
  const source = latestSessionFile(originalSessionDir);
  if (!source) return false;
  fs.mkdirSync(forkSessionDir, { recursive: true });
  const target = path.join(forkSessionDir, path.basename(source));
  const forkSuffix = `fork-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const lines = fs.readFileSync(source, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      try {
        const entry: unknown = JSON.parse(lines[i]);
        if (!isRecord(entry)) continue;
        if (entry.type === "session" && typeof entry.id === "string") {
          entry.id = `${entry.id}-${forkSuffix}`;
          lines[i] = JSON.stringify(entry);
        } else if (
          entry.type === "custom" &&
          entry.customType === SUBAGENT_NAMES_CUSTOM_TYPE &&
          isRecord(entry.data) &&
          typeof entry.data.ownerId === "string"
        ) {
          entry.data.ownerId = `${entry.data.ownerId}-${forkSuffix}`;
          lines[i] = JSON.stringify(entry);
        }
      } catch {
        /* leave the line untouched */
      }
    }
    fs.writeFileSync(target, lines.join("\n"), "utf8");
    return true;
  } catch {
    try {
      fs.copyFileSync(source, target);
      return true;
    } catch {
      return false;
    }
  }
}
