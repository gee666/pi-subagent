import type { DelegationMode, SingleResult, SubagentDetails, UsageTreeNode, ToolCallCounts } from "./contracts.js";
import {
  emptyUsage,
  addUsage,
  mergeToolCalls,
  usageSummaryToUsageStats,
  withSubagentIdentities,
  buildUsageSummary,
} from "./usage.js";
import { extractToolCalls, getFinalOutput, getNestedSubagentResults } from "./messages.js";

/** Keep compatibility fields readable without persisting them to parent sessions. */
function hideProperties<T extends object>(target: T, keys: Array<keyof T>): void {
  for (const key of keys) {
    Object.defineProperty(target, key, {
      value: target[key],
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

/** Build a UsageTreeNode for one result, recursing into nested subagent tool results */
function buildUsageTreeNode(result: SingleResult): UsageTreeNode {
  const messages = result.messages ?? [];
  const children: UsageTreeNode[] = [];
  for (const nested of getNestedSubagentResults(messages)) {
    for (const nestedResult of nested.details.results) {
      children.push(buildUsageTreeNode(nestedResult));
    }
  }

  const ownUsage = result.usage ?? emptyUsage();
  const ownToolCalls: ToolCallCounts = result.toolCalls ?? extractToolCalls(messages);

  const aggregatedUsage = emptyUsage();
  addUsage(aggregatedUsage, ownUsage);
  const priorDescendantUsage = usageSummaryToUsageStats(result.priorDescendantUsageSummary);
  if (priorDescendantUsage) addUsage(aggregatedUsage, priorDescendantUsage);
  for (const child of children) addUsage(aggregatedUsage, child.aggregatedUsage);

  const aggregatedToolCalls: ToolCallCounts = { ...ownToolCalls };
  for (const child of children) mergeToolCalls(aggregatedToolCalls, child.aggregatedToolCalls);

  return {
    agent: result.agent,
    task: result.task,
    ownUsage,
    ownToolCalls,
    aggregatedUsage,
    aggregatedToolCalls,
    children,
  };
}

/** Retain completion state and accounting while omitting transcripts from JSON. */
export function compactSingleResultForDurableDetails(result: SingleResult): SingleResult {
  const ref: SingleResult = {
    messages: [],
    stderr: "",
    turnInProgress: false,
    liveLog: [],
    stderrTruncatedChars: result.stderrTruncatedChars ?? Math.max(0, result.stderr?.length ?? 0),
    agent: result.agent,
    agentSource: result.agentSource,
    task: result.task,
    exitCode: result.exitCode,
    usage: result.usage ?? emptyUsage(),
    toolCalls: result.toolCalls ?? {},
    completedTurns: result.completedTurns ?? 0,
    finalOutput: result.finalOutput ?? getFinalOutput(result.messages ?? []),
    subtreeUsageSummary: result.subtreeUsageSummary
      ? withSubagentIdentities(result.subtreeUsageSummary, [result])
      : buildUsageSummary([result]),
    ...(result.name !== undefined ? { name: result.name } : {}),
    ...(result.startedAt !== undefined ? { startedAt: result.startedAt } : {}),
    ...(result.lastActionAt !== undefined ? { lastActionAt: result.lastActionAt } : {}),
    ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
    ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.sessionDir !== undefined ? { sessionDir: result.sessionDir } : {}),
    ...(result.budget !== undefined ? { budget: result.budget } : {}),
    ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
  };
  // Full transcripts and live process state stay non-enumerable so parent
  // sessions remain compact. Completion output and own usage above must survive
  // a JSON round-trip; otherwise crash-resume reuses a successful sibling as
  // "(no output)" with zero accounting.
  hideProperties(ref, [
    "messages",
    "stderr",
    "stderrTruncatedChars",
    "turnInProgress",
    "liveLog",
    "liveNestedSubagents",
    "priorDescendantUsageSummary",
  ]);
  return ref;
}

function aggregateDetailsFromUsageTree(
  mode: "single" | "parallel",
  delegationMode: DelegationMode,
  projectAgentsDir: string | null,
  results: SingleResult[],
  usageTree: UsageTreeNode[],
): SubagentDetails {
  const aggregatedUsage = emptyUsage();
  const aggregatedToolCalls: ToolCallCounts = {};
  for (const node of usageTree) {
    addUsage(aggregatedUsage, node.aggregatedUsage);
    mergeToolCalls(aggregatedToolCalls, node.aggregatedToolCalls);
  }

  return {
    mode,
    delegationMode,
    projectAgentsDir,
    results,
    aggregatedUsage,
    aggregatedToolCalls,
    usageTree,
  };
}

export function buildLiveSubagentDetails(
  mode: "single" | "parallel",
  delegationMode: DelegationMode,
  projectAgentsDir: string | null,
  results: SingleResult[],
): SubagentDetails {
  return aggregateDetailsFromUsageTree(
    mode,
    delegationMode,
    projectAgentsDir,
    results,
    results.map(buildUsageTreeNode),
  );
}

export function buildSubagentDetails(
  mode: "single" | "parallel",
  delegationMode: DelegationMode,
  projectAgentsDir: string | null,
  results: SingleResult[],
): SubagentDetails {
  const durableResults = results.map(compactSingleResultForDurableDetails);
  const usageTree = results.map(buildUsageTreeNode);
  const aggregate = aggregateDetailsFromUsageTree(mode, delegationMode, projectAgentsDir, results, usageTree);
  const details: SubagentDetails = {
    aggregatedUsage: aggregate.aggregatedUsage,
    aggregatedToolCalls: aggregate.aggregatedToolCalls,
    usageTree: [],
    schemaVersion: 3,
    mode,
    delegationMode,
    projectAgentsDir,
    results: durableResults,
    usageSummary: buildUsageSummary(results),
  };
  // Compatibility for older render/tests. Non-enumerable so persisted JSON keeps
  // the schema-v3 durable shape: refs + usageSummary only.
  hideProperties(details, ["aggregatedUsage", "aggregatedToolCalls", "usageTree"]);
  return details;
}
