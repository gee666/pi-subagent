import { RESUME_SUBAGENTS_TOOL_NAME } from "../types.js";
import { type ThemeFg, formatClockTime, formatTokens, truncate } from "./tree-format.js";
import type { DetailBlock, DetailChildRef, DetailUsage, SubagentDetail } from "./detail-model.js";
import {
  getTurnTools,
  getTurnResponse,
  getDetailChildren,
  getToolListRows,
  type TurnToolEvent,
} from "./detail-selectors.js";
export interface DetailTheme {
  fg: ThemeFg;
  bold: (text: string) => string;
}

const PLAIN_THEME: DetailTheme = { fg: (_color, text) => text, bold: (text) => text };

export function wrapPlain(text: string, width: number): string[] {
  const usable = Math.max(8, width);
  const out: string[] = [];
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\t/g, "  ");
    if (line.length <= usable) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > usable) {
      let cut = rest.lastIndexOf(" ", usable);
      if (cut < Math.floor(usable / 2)) cut = usable;
      out.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest) out.push(rest);
  }
  return out.length > 0 ? out : [""];
}

function statusIcon(status: DetailChildRef["status"]): string {
  return status === "running" ? "⏳" : status === "error" ? "❌" : "✅";
}

function usageLine(usage: DetailUsage): string {
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return `$${usage.cost.toFixed(4)} • ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)} T${formatTokens(total)} • ${usage.turns} turn${usage.turns === 1 ? "" : "s"}`;
}

function makeLineWriter(width: number, theme: DetailTheme) {
  const lines: string[] = [];
  return {
    lines,
    push: (text = "") => lines.push(text),
    wrap: (text: string, indent = "", color?: Parameters<ThemeFg>[0]) => {
      for (const line of wrapPlain(text, width - indent.length)) {
        lines.push(`${indent}${color ? theme.fg(color, line) : line}`);
      }
    },
    section: (title: string) => lines.push(theme.fg("toolTitle", theme.bold(title))),
  };
}

function toolLabel(event: TurnToolEvent): string {
  return event.type === "tool"
    ? event.name
    : event.toolName === RESUME_SUBAGENTS_TOOL_NAME
      ? "resume subagents"
      : "subagents";
}

function toolPreview(event: TurnToolEvent): string {
  if (event.type === "tool") return event.preview;
  return event.children.map((child) => child.name ?? child.agent).join(", ");
}

function toolIsError(event: TurnToolEvent): boolean {
  return event.type === "tool" ? Boolean(event.isError) : event.children.some((child) => child.status === "error");
}

export function renderTurnOverviewLines(
  detail: SubagentDetail,
  blockIndex: number,
  width: number,
  theme: DetailTheme = PLAIN_THEME,
): string[] {
  const out = makeLineWriter(width, theme);
  const block = detail.blocks[blockIndex];
  if (!block) {
    out.wrap("No turn data is available.", "", "warning");
    return out.lines;
  }

  const turnTitle = block.kind === "task" ? "Initial task" : `Resume #${block.index}`;
  const meta = [
    `Turn ${blockIndex + 1} of ${detail.blocks.length}: ${turnTitle}`,
    block.at ? formatClockTime(block.at) : "",
    detail.model ?? "",
  ]
    .filter(Boolean)
    .join(" • ");
  out.wrap(meta, "", "dim");
  out.wrap(`session total: ${usageLine(detail.usage)}`, "", "dim");
  for (const note of detail.notes) out.wrap(note, "", "warning");

  out.push();
  out.section("TASK");
  out.wrap(block.prompt || "(empty prompt)", "  ", block.prompt ? "toolOutput" : "muted");

  out.push();
  out.section("RESPONSE");
  const response = getTurnResponse(block);
  out.wrap(response || "(no final response in this turn)", "  ", response ? "toolOutput" : "muted");

  const tools = getTurnTools(block);
  out.push();
  out.section("TOOLS");
  if (tools.length === 0) {
    out.wrap("No tool calls", "  ", "muted");
  } else {
    const counts = new Map<string, number>();
    for (const event of tools) counts.set(toolLabel(event), (counts.get(toolLabel(event)) ?? 0) + 1);
    const summary = [...counts.entries()].map(([name, count]) => `${name} ×${count}`).join(", ");
    out.wrap(`${tools.length} call${tools.length === 1 ? "" : "s"}: ${summary}`, "  ", "dim");
    out.wrap("Press T to inspect tools", "  ", "muted");
  }

  const children = getDetailChildren(detail);
  if (children.length > 0) {
    out.push();
    out.section("CHILDREN (DIRECT)");
    children.forEach((child, index) => {
      const branch = index === children.length - 1 ? "└─" : "├─";
      const label = child.name ? `${child.name} (${child.agent})` : child.agent;
      const task = child.task
        ? ` — ${truncate(child.task.replace(/\s+/g, " "), Math.max(24, width - label.length - 13))}`
        : "";
      out.push(`  ${branch} ${statusIcon(child.status)} ${theme.fg("accent", label)}${theme.fg("dim", task)}`);
    });
    out.wrap("Press C to select and expand a child", "  ", "muted");
  }

  return out.lines;
}

export const TOOL_LIST_HEADER_LINES = 2;

export function renderTurnToolListLines(
  block: DetailBlock | undefined,
  selectedRow: number,
  width: number,
  theme: DetailTheme = PLAIN_THEME,
): string[] {
  const out = makeLineWriter(width, theme);
  const tools = getTurnTools(block);
  out.wrap(`${tools.length} tool call${tools.length === 1 ? "" : "s"} in this turn`, "", "dim");
  out.push();
  if (tools.length === 0) {
    out.wrap("No tool calls", "", "muted");
    return out.lines;
  }

  const rows = getToolListRows(block);
  rows.forEach((row, index) => {
    const marker = index === selectedRow ? theme.fg("accent", ">") : " ";
    if (row.kind === "tool") {
      const icon = toolIsError(row.event) ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const preview = row.event.type === "children" ? "" : toolPreview(row.event);
      out.push(
        `${marker} ${String(row.toolIndex + 1).padStart(2)} ${icon} ${theme.fg("accent", toolLabel(row.event))}${preview ? ` ${theme.fg("dim", truncate(preview.replace(/\s+/g, " "), Math.max(16, width - 18)))}` : ""}`,
      );
      return;
    }
    const siblings = rows.filter((other) => other.kind === "child" && other.toolIndex === row.toolIndex);
    const isLast = siblings[siblings.length - 1] === row;
    const label = row.child.name ? `${row.child.name} (${row.child.agent})` : row.child.agent;
    const hint = row.child.name ? theme.fg("muted", " ← Enter to expand") : theme.fg("muted", " (no name)");
    out.push(
      `${marker}      ${isLast ? "└─" : "├─"} ${statusIcon(row.child.status)} ${theme.fg("accent", label)}${index === selectedRow ? hint : ""}`,
    );
  });
  return out.lines;
}

export function renderChildTreeLines(
  children: DetailChildRef[],
  selectedIndex: number,
  width: number,
  theme: DetailTheme = PLAIN_THEME,
): string[] {
  const out = makeLineWriter(width, theme);
  out.wrap(`${children.length} direct child${children.length === 1 ? "" : "ren"}`, "", "dim");
  out.push();
  children.forEach((child, index) => {
    const marker = index === selectedIndex ? theme.fg("accent", ">") : " ";
    const branch = index === children.length - 1 ? "└─" : "├─";
    const label = child.name ? `${child.name} (${child.agent})` : child.agent;
    const task = child.task
      ? ` — ${truncate(child.task.replace(/\s+/g, " "), Math.max(16, width - label.length - 12))}`
      : "";
    out.push(`${marker} ${branch} ${statusIcon(child.status)} ${theme.fg("accent", label)}${theme.fg("dim", task)}`);
  });
  return out.lines;
}

export function renderToolDetailLines(
  event: TurnToolEvent | undefined,
  toolIndex: number,
  width: number,
  theme: DetailTheme = PLAIN_THEME,
): string[] {
  const out = makeLineWriter(width, theme);
  if (!event) {
    out.wrap("No tool call selected.", "", "warning");
    return out.lines;
  }
  const failed = toolIsError(event);
  out.push(
    `${failed ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${theme.bold(theme.fg("accent", `Tool ${toolIndex + 1}: ${toolLabel(event)}`))}`,
  );

  if (event.type === "tool") {
    out.push();
    out.section("ARGUMENTS");
    out.wrap(event.arguments && event.arguments !== "{}" ? event.arguments : "(none)", "  ", "toolOutput");
    out.push();
    out.section("RESULT");
    out.wrap(event.result || "(no textual result)", "  ", event.isError ? "error" : "toolOutput");
  } else {
    out.push();
    out.section("CHILDREN");
    for (const child of event.children) {
      const label = child.name ? `${child.name} (${child.agent})` : child.agent;
      out.push(`  ${statusIcon(child.status)} ${theme.fg("accent", label)}`);
      if (child.task) out.wrap(child.task, "     ", "toolOutput");
      if (child.name) out.push(`     ${theme.fg("muted", `/subagent-expand ${child.name}`)}`);
    }
  }
  return out.lines;
}

export function renderDetailLines(detail: SubagentDetail, width: number, theme: DetailTheme = PLAIN_THEME): string[] {
  return renderTurnOverviewLines(detail, Math.max(0, detail.blocks.length - 1), width, theme);
}
