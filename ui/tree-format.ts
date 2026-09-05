import {
  aggregateUsage,
  usageSummaryToUsageStats,
  type UsageStats,
  type SingleResult,
  type SubagentDetails,
} from "../types.js";
import type { NodeStatus, TreeNode, TreeCounts } from "./tree-model.js";
import { asRecord, finiteNumber, stringValue } from "./value.js";
export type ThemeFg = import("@earendil-works/pi-coding-agent").Theme["fg"];
export function formatClockTime(epochMs: number): string {
  const d = new Date(Number.isFinite(epochMs) ? epochMs : 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatTokens(count: number): string {
  const safeCount = finiteNumber(count);
  if (safeCount < 1000) return safeCount.toString();
  if (safeCount < 10000) return `${(safeCount / 1000).toFixed(1)}k`;
  if (safeCount < 1000000) return `${Math.round(safeCount / 1000)}k`;
  return `${(safeCount / 1000000).toFixed(1)}M`;
}

export function formatCombinedUsageStatusLine(usage: Partial<UsageStats>, subagentCount: number): string {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const turns = usage.turns ?? 0;
  const cost = usage.cost ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  const cache = cacheRead || cacheWrite ? ` R${formatTokens(cacheRead)} W${formatTokens(cacheWrite)}` : "";
  return `WITH SUBS: (${subagentCount}) Σ $${cost.toFixed(4)} • ↑${formatTokens(input)} ↓${formatTokens(output)}${cache} T${formatTokens(total)} • ${turns} turn${turns === 1 ? "" : "s"}`;
}

export function formatUsage(usage: Partial<UsageStats> | unknown, model?: unknown): string {
  const safeUsage = asRecord(usage);
  const input = finiteNumber(safeUsage.input);
  const output = finiteNumber(safeUsage.output);
  const cacheRead = finiteNumber(safeUsage.cacheRead);
  const cacheWrite = finiteNumber(safeUsage.cacheWrite);
  const cost = finiteNumber(safeUsage.cost);
  const contextTokens = finiteNumber(safeUsage.contextTokens);
  const turns = finiteNumber(safeUsage.turns);
  const parts: string[] = [];
  const totalTokens = input + output + cacheRead + cacheWrite;
  if (turns) parts.push(`${turns} turn${turns > 1 ? "s" : ""}`);
  if (totalTokens > 0) parts.push(`tok:${formatTokens(totalTokens)}`);
  if (input) parts.push(`in:${formatTokens(input)}`);
  if (output) parts.push(`out:${formatTokens(output)}`);
  if (cacheRead) parts.push(`cacheR:${formatTokens(cacheRead)}`);
  if (cacheWrite) parts.push(`cacheW:${formatTokens(cacheWrite)}`);
  if (cost) parts.push(`$${cost.toFixed(4)}`);
  if (contextTokens > 0) parts.push(`ctx:${formatTokens(contextTokens)}`);
  if (typeof model === "string" && model) parts.push(model);
  return parts.join(" • ");
}

export function truncate(text: unknown, maxLen: number): string {
  const safeText = stringValue(text);
  return safeText.length > maxLen ? `${safeText.slice(0, maxLen)}...` : safeText;
}

export function statusEmoji(status: NodeStatus, theme: { fg: ThemeFg }): string {
  switch (status) {
    case "running":
      return theme.fg("warning", "⏳");
    case "error":
      return theme.fg("error", "❌");
    default:
      return theme.fg("success", "✅");
  }
}

export function countNodes(nodes: TreeNode[]): TreeCounts {
  const counts: TreeCounts = {
    total: 0,
    running: 0,
    success: 0,
    error: 0,
    finished: 0,
  };

  const visit = (node: TreeNode) => {
    counts.total++;
    if (node.status === "running") counts.running++;
    if (node.status === "success") counts.success++;
    if (node.status === "error") counts.error++;
    if (node.status !== "running") counts.finished++;
    for (const child of node.children) visit(child);
  };

  for (const node of nodes) visit(node);
  return counts;
}

export function hasNestedChildren(nodes: TreeNode[]): boolean {
  return nodes.some((node) => node.children.length > 0 || hasNestedChildren(node.children));
}

export function topLevelSummary(
  details: SubagentDetails,
  counts: TreeCounts,
  options: { directOnly?: boolean } = {},
): string {
  const safeResults = details.results.filter(
    (result): result is SingleResult => result !== null && typeof result === "object" && !Array.isArray(result),
  );
  const totalUsage = formatUsage(
    usageSummaryToUsageStats(details.usageSummary) ?? details.aggregatedUsage ?? aggregateUsage(safeResults),
  );
  const historicalTotal = options.directOnly
    ? Math.max(counts.total, details.usageSummary?.subagentCount ?? 0)
    : counts.total;
  const historicalFinished = options.directOnly && counts.running === 0 ? historicalTotal : counts.finished;
  const outcomeScope = options.directOnly && historicalTotal > counts.total ? " direct" : "";
  const parts = [
    `${counts.running} running`,
    `${historicalFinished}/${historicalTotal} finished`,
    `${counts.success}${outcomeScope} ok`,
    `${counts.error}${outcomeScope} error`,
  ];
  if (totalUsage) parts.push(totalUsage);
  return parts.join(" • ");
}
