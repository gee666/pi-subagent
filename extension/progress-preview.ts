import { MAX_LIVE_LOG_ENTRIES, type LiveLogEntry } from "../types.js";
import { isRecord, recordArray } from "../types/records.js";

export const PROGRESS_ARGUMENT_CHARS = 256;
export const PROGRESS_ERROR_CHARS = 1000;
export const PROGRESS_OUTPUT_CHARS = 2048;

export function headPreview(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** Slice before splitting so preview construction never copies an entire large answer. */
export function outputPreview(value: string): string {
  return value
    .slice(-PROGRESS_OUTPUT_CHARS)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim())
    .slice(-6)
    .map((line) => headPreview(line, 240))
    .join("\n");
}

function argumentPreview(toolName: string, value: unknown): Record<string, unknown> {
  const args = isRecord(value) ? value : {};
  const strings = (keys: string[]) =>
    Object.fromEntries(
      keys.flatMap((key) => {
        const text = headPreview(args[key], PROGRESS_ARGUMENT_CHARS);
        return text === undefined ? [] : [[key, text]];
      }),
    );
  switch (toolName) {
    case "bash":
      return strings(["command"]);
    case "read":
    case "write":
    case "edit":
      return strings(["path", "file_path"]);
    case "grep":
    case "find":
      return strings(["pattern", "path"]);
    case "subagent":
    case "subagents":
      return {
        tasks: recordArray(args.tasks)
          .slice(0, MAX_LIVE_LOG_ENTRIES)
          .map((task) => ({ agent: headPreview(task.agent, PROGRESS_ARGUMENT_CHARS) })),
      };
    case "resume_subagents":
      return {
        resumes: recordArray(Array.isArray(args.resumes) ? args.resumes : [args.resumes])
          .slice(0, MAX_LIVE_LOG_ENTRIES)
          .map((resume) => ({
            subagent: headPreview(resume.subagent, PROGRESS_ARGUMENT_CHARS),
            name: headPreview(resume.name, PROGRESS_ARGUMENT_CHARS),
          })),
      };
    default:
      return {};
  }
}

export function progressLog(value: unknown): LiveLogEntry[] {
  const result: LiveLogEntry[] = [];
  for (const entry of recordArray(value).slice(-MAX_LIVE_LOG_ENTRIES)) {
    const at = typeof entry.at === "number" ? entry.at : undefined;
    const toolName = headPreview(entry.toolName, PROGRESS_ARGUMENT_CHARS) ?? "unknown tool";
    switch (entry.kind) {
      case "turn_start":
        result.push({ kind: "turn_start", at });
        break;
      case "turn_end":
        result.push({
          kind: "turn_end",
          at,
          turn: typeof entry.turn === "number" ? entry.turn : 0,
          inputTokens: typeof entry.inputTokens === "number" ? entry.inputTokens : 0,
          outputTokens: typeof entry.outputTokens === "number" ? entry.outputTokens : 0,
        });
        break;
      case "tool_start":
        result.push({ kind: "tool_start", at, toolName, args: argumentPreview(toolName, entry.args) });
        break;
      case "tool_end":
        result.push({ kind: "tool_end", at, toolName });
        break;
    }
  }
  return result;
}
