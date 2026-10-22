import * as fs from "node:fs";
import { sessionEntryMessage } from "../storage/session-entries.js";
import { findPersistedNamesIdentity } from "../names.js";
import { RESUME_PROVIDER } from "../shared.js";
import { formatCombinedUsageStatusLine } from "../tree.js";
import {
  type SubagentDetails,
  type SubagentUsageSummary,
  asyncJobId,
  subagentExecutionId,
  type UsageStats,
  addUsage,
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
import type { TranscriptMessage } from "../types/transcript.js";

// Histories append immutable finalized messages; mutable live snapshots are separate.
const usageHistories = new WeakMap<
  TranscriptMessage[],
  {
    length: number;
    last: unknown;
    messages: TranscriptMessage[];
    nested: ReturnType<typeof getNestedSubagentResults>;
  }
>();
function nestedForUsage(messages: TranscriptMessage[]) {
  let cache = usageHistories.get(messages);
  if (!cache || cache.length > messages.length || (cache.length > 0 && messages[cache.length - 1] !== cache.last)) {
    cache = { length: 0, last: undefined, messages: [], nested: [] };
    usageHistories.set(messages, cache);
  }
  const before = cache.messages.length;
  for (let i = cache.length; i < messages.length; i++) {
    const message = messages[i];
    if (!isRecord(message)) continue;
    if (
      (message.role === "toolResult" && isSubagentToolName(message.toolName)) ||
      (message.role === "custom" && Reflect.get(message, "customType") === "subagent_completion")
    ) {
      cache.messages.push(message);
    }
  }
  cache.length = messages.length;
  cache.last = messages[messages.length - 1];
  if (cache.messages.length !== before) cache.nested = getNestedSubagentResults(cache.messages);
  return cache.nested;
}

export function liveDetailsSignature(details: SubagentDetails): string {
  return JSON.stringify(
    details.results.map((result) => ({
      agent: result.agent,
      task: result.task ?? "",
    })),
  );
}

type UsageContribution = {
  executionIds?: string[];
  summary?: SubagentUsageSummary;
  children?: UsageContribution[];
};

// Keep per-execution accounting in memory without changing the durable summary schema.
const liveContributions = new WeakMap<SubagentUsageSummary, UsageContribution[]>();

function executionIds(details: SubagentDetails): string[] {
  return details.results.flatMap((result) => {
    const id = result.exitCode !== -1 ? subagentExecutionId(result) : undefined;
    return id ? [id] : [];
  });
}

function durableContributions(details: SubagentDetails): UsageContribution[] {
  // V3 refs retain each worker's subtree total, so partial batches can be split.
  if (details.results.length && details.results.every((result) => result.subtreeUsageSummary)) {
    return details.results.map((result) => ({
      executionIds: result.exitCode !== -1 && subagentExecutionId(result) ? [subagentExecutionId(result)!] : [],
      summary: withSubagentIdentities(result.subtreeUsageSummary!, [result]),
    }));
  }
  if (details.usageSummary) {
    return [
      { executionIds: executionIds(details), summary: withSubagentIdentities(details.usageSummary, details.results) },
    ];
  }
  return collectLiveContributions(details);
}

function addContributions(total: SubagentUsageSummary, parts: UsageContribution[], seen: Set<string>): void {
  const identities = new Set(total.subagentIds ?? []);
  const visit = (parts: UsageContribution[]) => {
    for (const part of parts) {
      if (part.executionIds?.length && part.executionIds.every((id) => seen.has(id))) continue;
      const summary = part.summary;
      if (summary) {
        let overlap = 0;
        for (const id of new Set(summary.subagentIds ?? [])) {
          if (identities.has(id)) overlap++;
          else identities.add(id);
        }
        total.subagentCount += Math.max(0, summary.subagentCount - overlap);
        total.inputTokens += summary.inputTokens;
        total.outputTokens += summary.outputTokens;
        total.cacheReadTokens += summary.cacheReadTokens;
        total.cacheWriteTokens += summary.cacheWriteTokens;
        total.costUsd += summary.costUsd;
        total.turns += summary.turns;
      }
      if (part.children) visit(part.children);
      for (const id of part.executionIds ?? []) seen.add(id);
    }
  };
  visit(parts);
  if (identities.size) total.subagentIds = [...identities];
}

function collectLiveContributions(details: SubagentDetails, excluded = new Set<string>()): UsageContribution[] {
  const parts: UsageContribution[] = [];
  for (const result of details.results) {
    const id = subagentExecutionId(result);
    if (id && excluded.has(id)) continue;
    const children: UsageContribution[] = [];
    parts.push({ executionIds: id ? [id] : [], children });
    if (result.subtreeUsageSummary) {
      children.push({ summary: withSubagentIdentities(result.subtreeUsageSummary, [result]) });
      continue;
    }
    children.push({ summary: usageSummaryFromUsage(result.usage, subagentIdentity(result)) });
    if (result.priorDescendantUsageSummary) children.push({ summary: result.priorDescendantUsageSummary });

    const completedNested = nestedForUsage(result.messages ?? []);
    const completedNestedIds = new Set<string>();
    const completedExecutions = new Set<string>();
    const completedSignatures = new Map<string, string[][]>();
    for (const nested of completedNested) {
      for (const result of nested.details.results) {
        const id = subagentExecutionId(result);
        if (result.exitCode !== -1 && id) completedExecutions.add(id);
      }
      // Async tool results are placeholders, not evidence that every sibling finished.
      if (!asyncJobId(nested.details)) {
        if (nested.toolCallId) completedNestedIds.add(nested.toolCallId);
        const signature = liveDetailsSignature(nested.details);
        const matches = completedSignatures.get(signature) ?? [];
        matches.push(executionIds(nested.details));
        completedSignatures.set(signature, matches);
      }
      children.push(...durableContributions(nested.details));
    }
    for (const [liveToolCallId, liveNested] of Object.entries(result.liveNestedSubagents ?? {})) {
      if (!isSubagentDetails(liveNested) || completedNestedIds.has(liveToolCallId)) continue;
      const signature = liveDetailsSignature(liveNested);
      const matches = completedSignatures.get(signature) ?? [];
      const liveIds = liveNested.results.flatMap((result) => {
        const id = subagentExecutionId(result);
        return id ? [id] : [];
      });
      // Task signatures are a legacy fallback, not evidence that a later resume
      // with an explicit, different execution identity is already accounted for.
      const match = matches.findIndex(
        (ids) =>
          !ids.length || !liveIds.length || (ids.length === liveIds.length && liveIds.every((id) => ids.includes(id))),
      );
      if (match >= 0) {
        matches.splice(match, 1);
        continue;
      }
      children.push(...collectLiveContributions(liveNested, completedExecutions));
    }
  }
  return parts;
}

export function collectLiveUsageSummary(details: SubagentDetails): SubagentUsageSummary {
  const summary = emptyUsageSummary();
  const parts = collectLiveContributions(details);
  addContributions(summary, parts, new Set());
  liveContributions.set(summary, parts);
  return summary;
}

export type PersistedUsageTotals = {
  leafId: unknown;
  sessionFile: unknown;
  hasEntries: boolean;
  parentUsage: UsageStats;
  subagents: SubagentUsageSummary;
  executions: Set<string>;
  namesFile?: string;
  registeredNames?: { signature: string; ids: string[]; aliases: Map<string, string> };
  entryCount: number;
  lastEntry: unknown;
  nestedMessages: unknown[];
  identityEntries: unknown[];
};

export function registeredSubagentIds(totals: PersistedUsageTotals): string[] | undefined {
  if (!totals.namesFile) return undefined;
  try {
    const stat = fs.statSync(totals.namesFile);
    const signature = `${totals.namesFile}:${stat.mtimeMs}:${stat.size}`;
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
  const sessionFile = typeof manager?.getSessionFile === "function" ? manager.getSessionFile() : undefined;
  if (persisted?.sessionFile !== sessionFile) persisted = undefined;

  if (!persisted || persisted.leafId !== leafId) {
    // Match Pi session totals: include off-branch history, compactions, and tool usage.
    const allEntries: unknown[] =
      canReadEntries && typeof manager?.getEntries === "function"
        ? manager.getEntries()
        : canReadEntries && leafId && typeof manager?.getBranch === "function"
          ? (manager.getBranch(leafId) ?? [])
          : [];
    // Verify Pi's immutable tail before incrementally accounting for appends.
    const appended =
      persisted &&
      persisted.entryCount <= allEntries.length &&
      (persisted.entryCount === 0 || allEntries[persisted.entryCount - 1] === persisted.lastEntry);
    const newEntries = appended ? allEntries.slice(persisted!.entryCount) : allEntries;
    const parentUsage = appended ? { ...persisted!.parentUsage } : emptyUsage();
    const nestedMessages = appended ? [...persisted!.nestedMessages] : [];
    const identityEntries = appended ? [...persisted!.identityEntries] : [];
    const previousNestedCount = nestedMessages.length;
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

    for (const entry of newEntries) {
      if (!isRecord(entry)) continue;
      if (entry.type === "custom" && entry.customType === "pi-subagent-names") identityEntries.push(entry);
      if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry.usage) {
        addRawUsage(entry.usage, false);
        continue;
      }
      const msg = sessionEntryMessage(entry);
      if (!msg) continue;
      if (
        (msg.role === "toolResult" && isSubagentToolName(msg.toolName)) ||
        (msg.role === "custom" && msg.customType === "subagent_completion")
      )
        nestedMessages.push(msg);
      if (msg.role === "assistant" && msg.provider !== RESUME_PROVIDER) {
        addRawUsage(msg.usage, Boolean(msg.usage));
      }
      // Delegated cost comes only from durable details, never also msg.usage.
      if (msg.role === "toolResult" && !isSubagentToolName(msg.toolName)) addRawUsage(msg.usage, false);
    }
    const reuseNested = appended && nestedMessages.length === previousNestedCount;
    const subagents = reuseNested ? persisted!.subagents : emptyUsageSummary();
    const executions = reuseNested ? persisted!.executions : new Set<string>();
    const contributions: UsageContribution[] = [];
    for (const nested of reuseNested ? [] : getNestedSubagentResults(nestedMessages)) {
      const details = nested.details;
      const parts =
        details.usageSummary || details.results.length
          ? durableContributions(details)
          : [{ summary: usageSummaryFromUsage(details.aggregatedUsage) }];
      contributions.push(...parts);
    }
    if (!reuseNested) addContributions(subagents, contributions, executions);
    persisted = {
      leafId,
      sessionFile,
      hasEntries: allEntries.length > 0,
      parentUsage,
      subagents,
      executions,
      entryCount: allEntries.length,
      lastEntry: allEntries[allEntries.length - 1],
      nestedMessages,
      identityEntries,
      namesFile: findPersistedNamesIdentity(identityEntries)?.namesFile,
      registeredNames: appended ? persisted?.registeredNames : undefined,
    };
    if (cacheKey && leafId !== undefined) persistedUsageCache.set(cacheKey, persisted);
  }

  if (!persisted.hasEntries && liveSummaries.length === 0) return undefined;
  const parentUsage = { ...persisted.parentUsage };
  const subagents = { ...persisted.subagents };
  const executions = new Set(persisted.executions);
  addContributions(
    subagents,
    liveSummaries.flatMap((summary) => liveContributions.get(summary) ?? [{ summary }]),
    executions,
  );
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
