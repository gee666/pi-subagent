import {
  Container,
  Spacer,
  Text,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

// Truncation emits SGR 0, which clears the enclosing toolbox's background.
// Reset text styling only; the parent owns the background and its right padding.
const fitLine = (text: string, width: number) =>
  truncateToWidth(text, width, "").replace(/\u001b\[0m/g, "\u001b[22;23;24;25;27;28;29;39m");

import { MAX_LIVE_LOG_ENTRIES, isSubagentDetails, type SubagentDetails } from "./types.js";
import { formatSubagentLabel } from "./ui/agent-label.js";
import {
  type ThemeFg,
  type TreeNode,
  buildTopLevelNodes,
  countNodes,
  formatClockTime,
  formatLiveLogEntry,
  hasNestedChildren,
  statusEmoji,
  renderTreeLines,
  setBroadcastNumberingActive,
  topLevelSummary,
  truncate,
} from "./tree.js";

export { setBroadcastNumberingActive };

const callStartTimes = new Map<string, number>();
const CALL_START_CACHE_LIMIT = 500;

const callSequence = new Map<string, number>();
let nextCallSequence = 0;
let newestCallId: string | undefined;

function registerCall(toolCallId: string | undefined): void {
  if (!toolCallId) return;
  let seq = callSequence.get(toolCallId);
  if (seq === undefined) {
    seq = nextCallSequence++;
    callSequence.set(toolCallId, seq);
    if (callSequence.size > CALL_START_CACHE_LIMIT) {
      const oldest = callSequence.keys().next().value;
      if (oldest !== undefined && oldest !== newestCallId) callSequence.delete(oldest);
    }
  }
  const newestSeq = newestCallId === undefined ? -1 : (callSequence.get(newestCallId) ?? -1);
  if (seq >= newestSeq) newestCallId = toolCallId;
}

export function setHistoricalCallOrder(toolCallIds: string[]): void {
  callSequence.clear();
  nextCallSequence = 0;
  newestCallId = undefined;
  for (const toolCallId of toolCallIds) registerCall(toolCallId);
}

export function isNewestCall(toolCallId: string | undefined): boolean {
  if (!toolCallId) return false;
  return newestCallId === toolCallId;
}

export function recordToolCallStart(toolCallId: string): void {
  registerCall(toolCallId);
  if (callStartTimes.has(toolCallId)) return;
  callStartTimes.set(toolCallId, Date.now());
  if (callStartTimes.size > CALL_START_CACHE_LIMIT) {
    const oldest = callStartTimes.keys().next().value;
    if (oldest !== undefined) callStartTimes.delete(oldest);
  }
}

export function clearRenderCaches(): void {
  callStartTimes.clear();
  callSequence.clear();
  nextCallSequence = 0;
  newestCallId = undefined;
}

function getCallStartStamp(context: { toolCallId?: string } | undefined, theme: { fg: ThemeFg }): string {
  const toolCallId = context?.toolCallId;
  if (!toolCallId) return "";
  const at = callStartTimes.get(toolCallId);
  if (at === undefined) return "";
  return `${theme.fg("dim", formatClockTime(at))} `;
}

export function renderCall(
  args: Record<string, unknown>,
  theme: { fg: ThemeFg; bold: (s: string) => string },
  context?: { isPartial?: boolean; isError?: boolean; toolCallId?: string },
): Text {
  registerCall(context?.toolCallId);
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  const count = tasks.length;
  const stamp = getCallStartStamp(context, theme);
  const text = `${stamp}${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`)}`;
  return new Text(text, 0, 0);
}

export function renderResumeCall(
  args: Record<string, unknown>,
  theme: { fg: ThemeFg; bold: (s: string) => string },
  context?: { isPartial?: boolean; isError?: boolean; toolCallId?: string },
): Text {
  const resumes = Array.isArray(args.resumes)
    ? args.resumes
    : args.resumes && typeof args.resumes === "object"
      ? [args.resumes]
      : [];
  registerCall(context?.toolCallId);
  const count = resumes.length;
  const stamp = getCallStartStamp(context, theme);
  const text = `${stamp}${theme.fg("toolTitle", theme.bold("resume subagents "))}${theme.fg("accent", `${count} subagent${count === 1 ? "" : "s"}`)}`;
  return new Text(text, 0, 0);
}

function getResultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  return first?.type === "text" && typeof first.text === "string" && first.text ? first.text : "(no output)";
}

function compactText(text: string, maxLength = 240): string {
  const firstLine =
    text
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .find((line) => line.trim()) ?? "(no output)";
  return truncate(firstLine, maxLength);
}

function takePromptLine(text: string, width: number): { line: string; rest: string } {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || width <= 0) return { line: "", rest: normalized };
  if (visibleWidth(normalized) <= width) return { line: normalized, rest: "" };
  const prefix = sliceByColumn(normalized, 0, width, true);
  let split = prefix.lastIndexOf(" ");
  if (split < 1 || visibleWidth(prefix.slice(0, split)) < Math.floor(width / 2)) split = prefix.length;
  return { line: normalized.slice(0, split), rest: normalized.slice(split).trimStart() };
}

class CollapsedSubagentComponent implements Component {
  constructor(
    private readonly details: SubagentDetails,
    private readonly theme: { fg: ThemeFg; bold: (s: string) => string },
  ) {}

  render(width: number): string[] {
    if (width <= 0) return [];
    const nodes = buildTopLevelNodes(this.details, { hydrateSessions: false });
    const lines: string[] = [];
    for (const node of nodes) {
      const prefix = `  ${statusEmoji(node.status, this.theme)} ${this.theme.fg("accent", node.label)} `;
      const prefixWidth = visibleWidth(prefix);
      const firstWidth = Math.max(0, width - prefixWidth);
      const first = takePromptLine(node.task ?? "", firstWidth);
      const continuationIndent = " ".repeat(Math.min(prefixWidth, Math.max(0, width - 8)));
      const secondWidth = Math.max(0, width - continuationIndent.length);
      const second = takePromptLine(first.rest, secondWidth);
      const firstLine = `${prefix}${this.theme.fg("dim", first.line)}`;
      lines.push(fitLine(firstLine, width));
      if (first.rest) {
        const hasMore = second.rest.length > 0;
        const secondText = hasMore ? truncateToWidth(first.rest, secondWidth) : second.line;
        lines.push(fitLine(`${continuationIndent}${this.theme.fg("dim", secondText)}`, width));
      }
      const actionAt = node.lastActionAt ?? node.startedAt;
      if (actionAt !== undefined) {
        lines.push(fitLine(`     ${this.theme.fg("muted", `last action: ${formatClockTime(actionAt)}`)}`, width));
      }
    }
    const counts = countNodes(nodes);
    if (lines.length > 0) lines.push("");
    lines.push(fitLine(this.theme.fg("dim", topLevelSummary(this.details, counts, { directOnly: true })), width));
    return lines;
  }

  invalidate(): void {}
}

type ResultRenderContext = {
  state?: Record<string, unknown>;
  toolCallId?: string;
};

function expandedNodes(details: SubagentDetails): TreeNode[] {
  return buildTopLevelNodes(details, { hydrateSessions: false });
}

export function renderResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  expanded: boolean,
  theme: { fg: ThemeFg; bold: (s: string) => string },
  context?: ResultRenderContext,
): Component | Container | Text {
  registerCall(context?.toolCallId);
  const fallbackText = getResultText(result);
  if (!expanded) {
    return isSubagentDetails(result.details) && result.details.results.length > 0
      ? new CollapsedSubagentComponent(result.details, theme)
      : new Text(compactText(fallbackText), 0, 0);
  }

  if (!isSubagentDetails(result.details) || result.details.results.length === 0) {
    return new Text(fallbackText, 0, 0);
  }
  const details: SubagentDetails = result.details;
  const verbose = !context?.toolCallId || isNewestCall(context.toolCallId);

  try {
    const nodes = expandedNodes(details);
    const counts = countNodes(nodes);
    const showOutputPreview = verbose && !hasNestedChildren(nodes);
    const icon = statusEmoji(counts.running > 0 ? "running" : counts.error > 0 ? "error" : "success", theme);

    const container = new Container();
    container.addChild(
      new Text(
        `${icon} ${theme.fg("toolTitle", theme.bold("subagent tree "))}${theme.fg("dim", topLevelSummary(details, counts))}`,
        0,
        0,
      ),
    );

    container.addChild(new Spacer(1));
    container.addChild(new Text(renderTreeLines(nodes, theme, showOutputPreview, 0, "", verbose).join("\n"), 0, 0));
    if (!verbose) {
      container.addChild(
        new Text(theme.fg("muted", "  /subagent-expand <name> for the full work of one subagent"), 0, 0),
      );
    }
    return container;
  } catch {
    const lines: string[] = [];
    for (const item of details.results) {
      const label = formatSubagentLabel({
        name: item?.name,
        agent: typeof item?.agent === "string" ? item.agent : "unknown agent",
        intelligence: item?.intelligence,
      });
      const icon = statusEmoji(item?.exitCode === -1 ? "running" : item?.exitCode === 0 ? "success" : "error", theme);
      lines.push(`${icon} ${theme.fg("accent", label)}`);
      const liveLog = Array.isArray(item?.liveLog) ? item.liveLog.slice(-MAX_LIVE_LOG_ENTRIES) : [];
      for (const entry of liveLog) {
        lines.push(`  ${formatLiveLogEntry(entry, theme)}`);
      }
    }
    return new Text(`${theme.fg("toolTitle", theme.bold("subagent tree"))}\n${lines.join("\n") || fallbackText}`, 0, 0);
  }
}
