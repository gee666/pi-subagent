import { sessionFilesIn, readSessionMessages } from "./session.js";
import {
  type NestedSubagentResult,
  type SingleResult,
  MAX_LIVE_LOG_ENTRIES,
  type SubagentDetails,
  getDisplayItems,
  getFinalOutput,
  getNestedSubagentResults,
  isResultError,
  isSubagentDetails,
  isSubagentToolName,
} from "../types.js";

import { asRecord, stringValue } from "./value.js";
import { formatUsage, truncate } from "./tree-format.js";
import type { TreeNode, NodeStatus } from "./tree-model.js";
export const OUTPUT_PREVIEW_LINE_COUNT = 6;
interface PendingSubagentCall {
  toolCallId: string;
  tasks: Array<{ agent: string; task?: string }>;
}

function splitOutputLines(text: unknown): string[] {
  const lines = stringValue(text).replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lastNonEmptyLines(text: unknown, limit: number): string[] {
  return splitOutputLines(text)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-limit);
}

function statusFromResult(result: SingleResult): NodeStatus {
  if (result.exitCode === -1) return "running";
  return isResultError(result) ? "error" : "success";
}

function extractPendingSubagentCalls(messages: SingleResult["messages"] | unknown): PendingSubagentCall[] {
  const history = Array.isArray(messages) ? messages : [];
  const calls: PendingSubagentCall[] = [];
  for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
    const message = asRecord(history[messageIndex]);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
      const part = asRecord(message.content[partIndex]);
      if (part?.type !== "toolCall" || !isSubagentToolName(part?.name)) continue;
      const args = asRecord(part.arguments);
      const tasks: PendingSubagentCall["tasks"] = [];
      if (Array.isArray(args.tasks)) {
        for (const raw of args.tasks) {
          const task = asRecord(raw);
          if (typeof task.agent === "string") {
            tasks.push({ agent: task.agent, task: typeof task.task === "string" ? task.task : undefined });
          }
        }
      } else if (args.resumes) {
        for (const raw of Array.isArray(args.resumes) ? args.resumes : [args.resumes]) {
          const resume = asRecord(raw);
          const agent = typeof resume.subagent === "string" ? resume.subagent : resume.name;
          if (typeof agent === "string") {
            tasks.push({
              agent,
              task:
                typeof resume.task === "string"
                  ? resume.task
                  : typeof resume.prompt === "string"
                    ? resume.prompt
                    : undefined,
            });
          }
        }
      }
      calls.push({
        toolCallId:
          typeof part.toolCallId === "string"
            ? part.toolCallId
            : typeof part.id === "string"
              ? part.id
              : `${messageIndex}:${partIndex}`,
        tasks,
      });
    }
  }
  return calls;
}

function buildPendingNodes(call: PendingSubagentCall): TreeNode[] {
  return call.tasks.map((task) => ({
    label: task.agent,
    status: "running",
    task: task.task,
    children: [],
  }));
}

function buildNodesFromDetails(details: SubagentDetails, hydrateSessions: boolean): TreeNode[] {
  return details.results.map((result) => buildResultNode(result, hydrateSessions));
}

function buildNodesFromNestedResult(nested: NestedSubagentResult, hydrateSessions: boolean): TreeNode[] {
  return buildNodesFromDetails(nested.details, hydrateSessions);
}

function subagentCallSignature(call: PendingSubagentCall): string {
  return JSON.stringify(call.tasks.map((task) => ({ agent: task.agent, task: task.task ?? "" })));
}

function nestedResultIsHealthy(nested: NestedSubagentResult | undefined): boolean {
  if (!nested || nested.isError) return false;
  return nested.details.results.every(
    (result) => result !== null && typeof result === "object" && !Array.isArray(result) && !isResultError(result),
  );
}

function buildLiveDetailsSignature(details: SubagentDetails): string {
  return JSON.stringify(
    details.results.map((result) => {
      const value = asRecord(result);
      return { agent: stringValue(value.agent), task: stringValue(value.task) };
    }),
  );
}

type NestedSource = Pick<SingleResult, "exitCode" | "sessionDir" | "liveNestedSubagents"> & { messages: unknown };

function findLiveNestedDetailsForCall(
  result: NestedSource,
  call: PendingSubagentCall,
  usedLiveKeys: Set<string>,
): SubagentDetails | undefined {
  const live = result.liveNestedSubagents;
  if (!live) return undefined;

  const byId = live[call.toolCallId];
  if (isSubagentDetails(byId)) {
    usedLiveKeys.add(call.toolCallId);
    return byId;
  }
  const signature = subagentCallSignature(call);
  for (const [key, details] of Object.entries(live)) {
    if (usedLiveKeys.has(key) || !isSubagentDetails(details)) continue;
    if (buildLiveDetailsSignature(details) !== signature) continue;
    usedLiveKeys.add(key);
    return details;
  }
  const agentSignature = JSON.stringify(call.tasks.map((task) => task.agent));
  for (const [key, details] of Object.entries(live)) {
    if (usedLiveKeys.has(key) || !isSubagentDetails(details)) continue;
    const liveAgentSignature = JSON.stringify(
      details.results.map((nestedResult) => stringValue(asRecord(nestedResult).agent)),
    );
    if (liveAgentSignature !== agentSignature) continue;
    usedLiveKeys.add(key);
    return details;
  }

  return undefined;
}

function buildNestedChildren(result: NestedSource, hydrateSessions: boolean): TreeNode[] {
  if (
    hydrateSessions &&
    (!Array.isArray(result.messages) || result.messages.length === 0) &&
    typeof result.sessionDir === "string"
  ) {
    return loadNestedNodesFromSession(result.sessionDir);
  }
  const parentIsRunning = result.exitCode === -1;
  const completedByToolCallId = new Map<string, NestedSubagentResult>();
  for (const nested of getNestedSubagentResults(result.messages)) {
    completedByToolCallId.set(nested.toolCallId, nested);
  }
  const usedLiveKeys = new Set<string>();

  const calls = extractPendingSubagentCalls(result.messages);
  const laterResumeBySignature = new Map<string, number>();
  calls.forEach((call, index) => {
    const completed = completedByToolCallId.get(call.toolCallId);
    if (!completed || nestedResultIsHealthy(completed)) {
      laterResumeBySignature.set(subagentCallSignature(call), index);
    }
  });

  const nodes: TreeNode[] = [];
  calls.forEach((call, index) => {
    const completed = completedByToolCallId.get(call.toolCallId);
    const newerEquivalent = laterResumeBySignature.get(subagentCallSignature(call));
    if (
      newerEquivalent !== undefined &&
      newerEquivalent > index &&
      (!completed || completed.isError || !nestedResultIsHealthy(completed))
    ) {
      return;
    }

    if (completed && isSubagentDetails(completed.details)) {
      nodes.push(...buildNodesFromNestedResult(completed, hydrateSessions));
      return;
    }

    const liveDetails = parentIsRunning ? findLiveNestedDetailsForCall(result, call, usedLiveKeys) : undefined;
    if (liveDetails) {
      nodes.push(...buildNodesFromDetails(liveDetails, hydrateSessions));
      return;
    }
    if (parentIsRunning) nodes.push(...buildPendingNodes(call));
  });
  return nodes;
}

function buildLeafPreview(result: SingleResult): string[] | undefined {
  const items = getDisplayItems(result.messages);
  const lines: string[] = [];
  for (const item of items) {
    if (item.type === "text") {
      lines.push(...lastNonEmptyLines(item.text, OUTPUT_PREVIEW_LINE_COUNT));
    }
  }
  const finalOutput = getFinalOutput(result.messages, result.finalOutput);
  if (finalOutput) lines.push(...lastNonEmptyLines(finalOutput, OUTPUT_PREVIEW_LINE_COUNT));
  const unique = lines.filter((line, index) => line && lines.indexOf(line) === index);
  return unique.length > 0 ? unique.slice(-OUTPUT_PREVIEW_LINE_COUNT) : undefined;
}

function loadNestedNodesFromSession(sessionDir: string): TreeNode[] {
  const files = sessionFilesIn(sessionDir);
  const file = files[files.length - 1];
  if (!file) return [];
  const messages = readSessionMessages(file).map((entry) => asRecord(entry).message);
  return buildNestedChildren({ exitCode: 0, messages }, true);
}

function buildResultNode(rawResult: SingleResult, hydrateSessions: boolean): TreeNode {
  let result: SingleResult;
  if (
    rawResult !== null &&
    typeof rawResult === "object" &&
    !Array.isArray(rawResult) &&
    typeof rawResult.agent === "string" &&
    typeof rawResult.exitCode === "number"
  ) {
    result = rawResult;
  } else {
    result = {
      agent: "unknown agent",
      agentSource: "unknown",
      task: "",
      exitCode: 1,
      messages: [],
      stderr: "Malformed subagent result.",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      toolCalls: {},
      completedTurns: 0,
      turnInProgress: false,
      liveLog: [],
    };
  }
  const status = statusFromResult(result);
  const usage = formatUsage(result.usage, result.model);
  const metaParts: string[] = [];
  if (typeof result.agentSource === "string" && result.agentSource) metaParts.push(result.agentSource);
  if (usage) metaParts.push(usage);
  if (status === "error") {
    const errorText = result.errorMessage || result.stderr || result.stopReason;
    if (typeof errorText === "string" && errorText) {
      metaParts.push(truncate(errorText.replace(/\s+/g, " "), 120));
    }
  }

  const children = buildNestedChildren(result, hydrateSessions);
  const isRunning = status === "running";
  const liveLog = Array.isArray(result.liveLog) ? result.liveLog : [];
  const ownLastAction =
    typeof result.lastActionAt === "number" && Number.isFinite(result.lastActionAt)
      ? result.lastActionAt
      : liveLog.reduce(
          (latest, entry) => Math.max(latest, typeof entry.at === "number" ? entry.at : 0),
          result.startedAt ?? 0,
        );
  const descendantLastAction = children.reduce((latest, child) => Math.max(latest, child.lastActionAt ?? 0), 0);
  const agentType = stringValue(result.agent, "unknown agent");
  const humanName = typeof result.name === "string" && result.name ? result.name : undefined;
  return {
    label: humanName ? `${humanName} (${agentType})` : agentType,
    status,
    meta: metaParts.join(" • "),
    task: typeof result.task === "string" ? result.task : undefined,
    startedAt: typeof result.startedAt === "number" && Number.isFinite(result.startedAt) ? result.startedAt : undefined,
    lastActionAt: Math.max(ownLastAction, descendantLastAction) || undefined,
    liveActivity: isRunning && liveLog.length > 0 ? liveLog.slice(-MAX_LIVE_LOG_ENTRIES) : undefined,
    outputPreview: !isRunning && children.length === 0 ? buildLeafPreview(result) : undefined,
    children,
  };
}

export function buildTopLevelNodes(details: SubagentDetails, options: { hydrateSessions?: boolean } = {}): TreeNode[] {
  return details.results.map((result) => buildResultNode(result, options.hydrateSessions !== false));
}
