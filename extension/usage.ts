import * as fs from "node:fs";
import { findPersistedNamesIdentity } from "../names.js";
import { RESUME_PROVIDER } from "../shared.js";
import { formatCombinedUsageStatusLine } from "../tree.js";
import {
  type SubagentDetails,
  type SubagentUsageSummary,
  type UsageStats,
  addUsage,
  addUsageSummary,
  emptyUsage,
  emptyUsageSummary,
  getNestedSubagentResults,
  isSubagentDetails,
  isSubagentToolName,
  subagentIdentity,
  usageSummaryFromUsage,
  usageSummaryToUsageStats,
  withSubagentIdentities,
} from "../types.js";
import { isRecord } from "./contracts.js";

export function liveDetailsSignature(details: SubagentDetails): string {
  return JSON.stringify(
    details.results.map((result) => ({
      agent: result.agent,
      task: result.task ?? "",
    })),
  );
}

export function collectLiveUsageSummary(details: SubagentDetails): SubagentUsageSummary {
  const summary = emptyUsageSummary();
  for (const result of details.results) {
    if (result.subtreeUsageSummary) {
      addUsageSummary(summary, withSubagentIdentities(result.subtreeUsageSummary, [result]));
      continue;
    }
    addUsageSummary(summary, usageSummaryFromUsage(result.usage, subagentIdentity(result)));
    if (result.priorDescendantUsageSummary) {
      addUsageSummary(summary, result.priorDescendantUsageSummary);
    }

    const completedNested = getNestedSubagentResults(result.messages ?? []);
    const completedNestedIds = new Set<string>();
    const completedNestedSignatureCounts = new Map<string, number>();
    for (const nested of completedNested) {
      if (nested.toolCallId) completedNestedIds.add(nested.toolCallId);
      const signature = liveDetailsSignature(nested.details);
      completedNestedSignatureCounts.set(signature, (completedNestedSignatureCounts.get(signature) ?? 0) + 1);
      addUsageSummary(
        summary,
        nested.details.usageSummary
          ? withSubagentIdentities(nested.details.usageSummary, nested.details.results)
          : collectLiveUsageSummary(nested.details),
      );
    }

    for (const [liveToolCallId, liveNested] of Object.entries(result.liveNestedSubagents ?? {})) {
      if (!isSubagentDetails(liveNested)) continue;
      // Prefer durable completed toolResult messages over matching live progress.
      // Some Pi versions key live progress differently than final tool results,
      // so also de-dupe by requested child agent/task signature as a multiset.
      if (completedNestedIds.has(liveToolCallId)) continue;
      const signature = liveDetailsSignature(liveNested);
      const completedSignatureCount = completedNestedSignatureCounts.get(signature) ?? 0;
      if (completedSignatureCount > 0) {
        completedNestedSignatureCounts.set(signature, completedSignatureCount - 1);
        continue;
      }
      addUsageSummary(summary, collectLiveUsageSummary(liveNested));
    }
  }
  return summary;
}

export type PersistedUsageTotals = {
  leafId: unknown;
  hasEntries: boolean;
  parentUsage: UsageStats;
  subagents: SubagentUsageSummary;
  namesFile?: string;
  registeredNames?: { signature: string; ids: string[]; aliases: Map<string, string> };
};

export function registeredSubagentIds(totals: PersistedUsageTotals): string[] | undefined {
  if (!totals.namesFile) return undefined;
  try {
    const stat = fs.statSync(totals.namesFile);
    const signature = `${stat.mtimeMs}:${stat.size}`;
    if (totals.registeredNames?.signature === signature) return totals.registeredNames.ids;
    const registry: unknown = JSON.parse(fs.readFileSync(totals.namesFile, "utf8"));
    if (!isRecord(registry) || !isRecord(registry.agents)) return undefined;
    const ids = Object.keys(registry.agents).map((name) => `name:${name.toLowerCase()}`);
    const aliases = new Map<string, string>();
    for (const [name, record] of Object.entries(registry.agents)) {
      if (!isRecord(record)) continue;
      const id = `name:${name.toLowerCase()}`;
      if (record?.sessionDir) aliases.set(`session:${record.sessionDir}`, id);
      if (isRecord(record.budget) && record.budget.directory) aliases.set(`budget:${record.budget.directory}`, id);
      for (const fork of Object.values(isRecord(record.forks) ? record.forks : {})) {
        if (isRecord(fork) && fork.sessionDir) aliases.set(`session:${fork.sessionDir}`, id);
      }
    }
    totals.registeredNames = { signature, ids, aliases };
    return ids;
  } catch {
    return undefined;
  }
}

export const persistedUsageCache = new WeakMap<object, PersistedUsageTotals>();

export function collectCombinedUsageStatusLine(
  ctx: unknown,
  liveSummaries: SubagentUsageSummary[] = [],
): string | undefined {
  const manager = isRecord(ctx) && isRecord(ctx.sessionManager) ? ctx.sessionManager : undefined;
  const canReadEntries = typeof manager?.getEntries === "function" || typeof manager?.getBranch === "function";
  const leafId = typeof manager?.getLeafId === "function" ? manager.getLeafId() : undefined;
  const cacheKey = manager !== null && typeof manager === "object" ? manager : undefined;
  let persisted = cacheKey && leafId !== undefined ? persistedUsageCache.get(cacheKey) : undefined;

  if (!persisted || persisted.leafId !== leafId) {
    // Match Pi session totals: include off-branch history, compactions, and tool usage.
    const allEntries: unknown[] =
      canReadEntries && typeof manager?.getEntries === "function"
        ? manager.getEntries()
        : canReadEntries && leafId && typeof manager?.getBranch === "function"
          ? (manager.getBranch(leafId) ?? [])
          : [];
    const parentUsage = emptyUsage();
    const subagents = emptyUsageSummary();
    const addRawUsage = (usage: unknown, countTurn: boolean) => {
      if (!isRecord(usage)) return;
      parentUsage.input += typeof usage.input === "number" ? usage.input : 0;
      parentUsage.output += typeof usage.output === "number" ? usage.output : 0;
      parentUsage.cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
      parentUsage.cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
      parentUsage.cost +=
        typeof usage.cost === "number"
          ? usage.cost
          : isRecord(usage.cost) && typeof usage.cost.total === "number"
            ? usage.cost.total
            : 0;
      if (countTurn) parentUsage.turns += 1;
    };

    for (const entry of allEntries) {
      if (!isRecord(entry)) continue;
      if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry.usage) {
        addRawUsage(entry.usage, false);
        continue;
      }
      if (entry?.type !== "message") continue;
      const msg = entry.message;
      if (!isRecord(msg)) continue;
      if (msg.role === "assistant" && msg.provider !== RESUME_PROVIDER) {
        addRawUsage(msg.usage, Boolean(msg.usage));
      }
      if (msg.role === "toolResult") {
        if (isSubagentToolName(msg.toolName)) {
          // Delegated cost is accounted through the durable usage summary only;
          // never also via msg.usage, or it would be counted twice.
          if (isSubagentDetails(msg.details)) {
            addUsageSummary(
              subagents,
              withSubagentIdentities(
                msg.details.usageSummary ?? usageSummaryFromUsage(msg.details.aggregatedUsage),
                msg.details.results,
              ),
            );
          }
        } else {
          addRawUsage(msg.usage, false);
        }
      }
    }
    persisted = {
      leafId,
      hasEntries: allEntries.length > 0,
      parentUsage,
      subagents,
      namesFile: findPersistedNamesIdentity(allEntries)?.namesFile,
    };
    if (cacheKey && leafId !== undefined) persistedUsageCache.set(cacheKey, persisted);
  }

  if (!persisted.hasEntries && liveSummaries.length === 0) return undefined;
  const parentUsage = { ...persisted.parentUsage };
  const subagents = { ...persisted.subagents };
  for (const liveSummary of liveSummaries) addUsageSummary(subagents, liveSummary);
  addUsage(parentUsage, usageSummaryToUsageStats(subagents) ?? emptyUsage());
  const registered = registeredSubagentIds(persisted);
  const uniqueCount = registered?.length
    ? new Set([
        ...registered,
        ...(subagents.subagentIds ?? []).map((id) => persisted.registeredNames?.aliases.get(id) ?? id),
      ]).size
    : subagents.subagentCount;
  return formatCombinedUsageStatusLine(parentUsage, uniqueCount);
}
