import type { SingleResult, UsageStats, SubagentUsageSummary, ToolCallCounts } from "./contracts.js";
import { getNestedSubagentResults } from "./messages.js";
/** Create an empty UsageStats object. */
export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Sum usage across multiple results. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
  const total = emptyUsage();
  for (const r of results) {
    addUsage(total, r.usage ?? emptyUsage());
  }
  return total;
}

/** Add delta into total in-place (contextTokens is a snapshot—not summed, left as-is in total) */
export function addUsage(total: UsageStats, delta: UsageStats): void {
  total.input += delta.input;
  total.output += delta.output;
  total.cacheRead += delta.cacheRead;
  total.cacheWrite += delta.cacheWrite;
  total.cost += delta.cost;
  total.turns += delta.turns;
}

/** Merge tool call counts from `source` into `target` in-place */
export function mergeToolCalls(target: ToolCallCounts, source: ToolCallCounts): void {
  for (const [name, count] of Object.entries(source)) {
    target[name] = (target[name] ?? 0) + count;
  }
}

export function emptyUsageSummary(): SubagentUsageSummary {
  return {
    subagentCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

export function addUsageSummary(total: SubagentUsageSummary, delta: SubagentUsageSummary): void {
  const known = new Set(total.subagentIds ?? []);
  const incoming = new Set(delta.subagentIds ?? []);
  const overlap = [...incoming].filter((id) => known.has(id)).length;
  total.subagentCount += Math.max(0, delta.subagentCount - overlap);
  if (incoming.size) total.subagentIds = [...new Set([...known, ...incoming])];
  total.inputTokens += delta.inputTokens;
  total.outputTokens += delta.outputTokens;
  total.cacheReadTokens += delta.cacheReadTokens;
  total.cacheWriteTokens += delta.cacheWriteTokens;
  total.costUsd += delta.costUsd;
  total.turns += delta.turns;
}

export function subagentIdentity(result: SingleResult): string | undefined {
  if (result.name) return `name:${result.name.toLowerCase()}`;
  if (result.budget?.directory) return `budget:${result.budget.directory}`;
  if (result.sessionDir) return `session:${result.sessionDir}`;
  if (result.sessionId) return `session-id:${result.sessionId}`;
  return undefined;
}

/** Add recoverable identities to older summaries without changing their usage. */
export function withSubagentIdentities(summary: SubagentUsageSummary, results: SingleResult[]): SubagentUsageSummary {
  const ids = new Set(summary.subagentIds ?? []);
  const visit = (result: SingleResult) => {
    const id = subagentIdentity(result);
    if (id) ids.add(id);
    for (const saved of [result.subtreeUsageSummary, result.priorDescendantUsageSummary]) {
      for (const id of saved?.subagentIds ?? []) ids.add(id);
    }
    for (const nested of getNestedSubagentResults(result.messages ?? [])) {
      for (const id of nested.details.usageSummary?.subagentIds ?? []) ids.add(id);
      nested.details.results.forEach(visit);
    }
  };
  results.forEach(visit);
  return ids.size
    ? { ...summary, subagentIds: [...ids], subagentCount: Math.max(summary.subagentCount, ids.size) }
    : summary;
}

export function usageSummaryFromUsage(usage: UsageStats | undefined, identity?: string): SubagentUsageSummary {
  return {
    subagentCount: 1,
    ...(identity ? { subagentIds: [identity] } : {}),
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    cacheWriteTokens: usage?.cacheWrite ?? 0,
    costUsd: usage?.cost ?? 0,
    turns: usage?.turns ?? 0,
  };
}

export function buildUsageSummary(results: SingleResult[]): SubagentUsageSummary {
  const total = emptyUsageSummary();
  for (const result of results) {
    // Completed siblings restored from durable details no longer have their
    // nested transcripts. Reuse the persisted subtree total instead of
    // silently dropping descendant accounting during a crash-resume rebuild.
    if (result.subtreeUsageSummary) {
      addUsageSummary(total, withSubagentIdentities(result.subtreeUsageSummary, [result]));
      continue;
    }
    addUsageSummary(total, usageSummaryFromUsage(result.usage, subagentIdentity(result)));
    if (result.priorDescendantUsageSummary) {
      addUsageSummary(total, result.priorDescendantUsageSummary);
    }
    for (const nested of getNestedSubagentResults(result.messages ?? [])) {
      addUsageSummary(
        total,
        nested.details.usageSummary
          ? withSubagentIdentities(nested.details.usageSummary, nested.details.results)
          : buildUsageSummary(nested.details.results),
      );
    }
  }
  return total;
}

export function usageSummaryToUsageStats(summary: SubagentUsageSummary | undefined): UsageStats | undefined {
  if (!summary) return undefined;
  return {
    input: summary.inputTokens,
    output: summary.outputTokens,
    cacheRead: summary.cacheReadTokens,
    cacheWrite: summary.cacheWriteTokens,
    cost: summary.costUsd,
    contextTokens: 0,
    turns: summary.turns,
  };
}
