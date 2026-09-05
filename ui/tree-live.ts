import * as os from "node:os";
import type { LiveLogEntry } from "../types.js";
import { type ThemeFg, formatClockTime, formatTokens } from "./tree-format.js";
import { asRecord, finiteNumber, stringValue } from "./value.js";
function formatToolArgPreview(toolName: unknown, rawArgs: unknown): string {
  const args = asRecord(rawArgs);
  const shorten = (value: unknown) => {
    const p = stringValue(value);
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };
  const truncateTo = (value: unknown, n: number) => {
    const text = stringValue(value);
    return text.length > n ? text.slice(0, n) + "\u2026" : text;
  };

  switch (toolName) {
    case "bash":
      return truncateTo(stringValue(args.command).replace(/\s+/g, " "), 52);
    case "read":
    case "write":
    case "edit":
      return shorten(truncateTo(args.path ?? args.file_path, 52));
    case "grep": {
      const pattern = stringValue(args.pattern);
      const target = stringValue(args.path);
      return truncateTo(`/${pattern}/`, 30) + (target ? ` in ${shorten(target)}` : "");
    }
    case "find": {
      const pattern = stringValue(args.pattern, "*");
      const target = stringValue(args.path);
      return truncateTo(pattern, 30) + (target ? ` in ${shorten(target)}` : "");
    }
    case "subagent":
    case "subagents": {
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      return tasks
        .map((task) => stringValue(asRecord(task).agent))
        .filter(Boolean)
        .join(", ");
    }
    case "resume_subagents": {
      const raw = args.resumes;
      const resumes = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
      return resumes
        .map((resume) => {
          const item = asRecord(resume);
          return stringValue(item.subagent) || stringValue(item.name);
        })
        .filter(Boolean)
        .join(", ");
    }
    default:
      return "";
  }
}

export function formatLiveLogEntry(entry: LiveLogEntry, theme: { fg: ThemeFg }): string {
  const value = asRecord(entry);
  const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : undefined;
  const stamp = at !== undefined ? theme.fg("dim", formatClockTime(at)) + " " : "";
  return stamp + formatLiveLogEntryBody(value, theme);
}

function formatLiveLogEntryBody(entry: Record<string, unknown>, theme: { fg: ThemeFg }): string {
  switch (entry.kind) {
    case "turn_start":
      return theme.fg("muted", "\u27f3") + " " + theme.fg("dim", "thinking\u2026");

    case "turn_end": {
      const inputTokens = finiteNumber(entry.inputTokens);
      const outputTokens = finiteNumber(entry.outputTokens);
      const tokens =
        inputTokens || outputTokens
          ? " " + theme.fg("dim", `\u2191${formatTokens(inputTokens)} \u2193${formatTokens(outputTokens)}`)
          : "";
      const turn = finiteNumber(entry.turn);
      return theme.fg("success", "\u2713") + " " + theme.fg("muted", `turn ${turn}`) + tokens;
    }

    case "tool_start": {
      const toolName = stringValue(entry.toolName, "unknown tool");
      const argPreview = formatToolArgPreview(toolName, entry.args);
      return (
        theme.fg("muted", "\u2192") +
        " " +
        theme.fg("accent", toolName) +
        (argPreview ? "  " + theme.fg("dim", argPreview) : "")
      );
    }

    case "tool_end":
      return theme.fg("success", "\u2713") + " " + theme.fg("accent", stringValue(entry.toolName, "unknown tool"));

    default:
      return theme.fg("muted", "activity");
  }
}
