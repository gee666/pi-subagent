import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { isRecord } from "./values.js";

/** Separate from the names lock: SIGKILL may leave that lock owned by a dead worker. */
export function persistWorkerStops(file: string, names: string[], at = Date.now()): void {
  if (!file || !names.length) return;
  const directory = `${file}.stops`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = `${at}-${randomUUID()}`;
  const candidate = path.join(directory, `${id}.tmp`);
  const destination = path.join(directory, `${id}.json`);
  const fd = fs.openSync(candidate, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify({ names: [...new Set(names)], at }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(candidate, destination);
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}

export function readWorkerStops(file: string): Map<string, number> {
  const stops = new Map<string, number>();
  const directory = `${file}.stops`;
  let filenames: string[];
  try {
    filenames = fs.readdirSync(directory);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return stops;
    throw new Error(`Cannot read worker stop markers at ${directory}; automatic recovery is blocked.`);
  }
  for (const filename of filenames) {
    if (!filename.endsWith(".json")) continue;
    try {
      const event: unknown = JSON.parse(fs.readFileSync(path.join(directory, filename), "utf8"));
      if (
        !isRecord(event) ||
        typeof event.at !== "number" ||
        !Number.isFinite(event.at) ||
        !Array.isArray(event.names) ||
        !event.names.every((name) => typeof name === "string")
      )
        throw new Error("invalid stop marker");
      for (const name of event.names) stops.set(name, Math.max(stops.get(name) ?? 0, event.at));
    } catch {
      throw new Error(
        `Invalid worker stop marker at ${path.join(directory, filename)}; automatic recovery is blocked.`,
      );
    }
  }
  return stops;
}
