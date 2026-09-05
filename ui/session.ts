import * as fs from "node:fs";
import * as path from "node:path";
import { asRecord } from "./value.js";

export function sessionFilesIn(sessionDir: string): string[] {
  try {
    return fs
      .readdirSync(sessionDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const file = path.join(sessionDir, name);
        return { file, mtimeMs: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
      .map((entry) => entry.file);
  } catch {
    return [];
  }
}

export function readSessionMessages(file: string): unknown[] {
  const messages: unknown[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return messages;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry?.type === "message" && entry.message) messages.push(entry);
  }
  return messages;
}
