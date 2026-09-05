import { sessionFilesIn, readSessionMessages } from "./session.js";
export { sessionFilesIn, readSessionMessages } from "./session.js";
import * as os from "node:os";
import type { NamesRegistry, SubagentNameRecord } from "../names.js";
import {
  type SubagentDetails,
  isSubagentDetails,
  isSubagentLaunchToolName,
  RESUME_SUBAGENTS_TOOL_NAME,
} from "../types.js";
import type { DetailBlock, DetailUsage, DetailEvent, DetailChildRef, SubagentDetail } from "./detail-model.js";
import { asRecord } from "./value.js";
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const item = asRecord(part);
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

function shortenPath(value: string): string {
  const home = os.homedir();
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

export function describeToolArgs(toolName: string, rawArgs: unknown): string {
  const args = asRecord(rawArgs);
  const clip = (value: unknown, n: number) => {
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    return text.length > n ? `${text.slice(0, n)}…` : text;
  };
  switch (toolName) {
    case "bash":
      return clip(args.command, 120);
    case "read":
    case "write":
    case "edit":
      return shortenPath(clip(args.path ?? args.file_path, 120));
    case "grep":
      return `/${clip(args.pattern, 60)}/${args.path ? ` in ${shortenPath(clip(args.path, 60))}` : ""}`;
    case "find":
      return `${clip(args.pattern ?? "*", 60)}${args.path ? ` in ${shortenPath(clip(args.path, 60))}` : ""}`;
    default: {
      const first = Object.entries(args)[0];
      if (!first) return "";
      const [key, value] = first;
      if (typeof value === "string") return `${key}: ${clip(value, 100)}`;
      return `${key}: ${clip(JSON.stringify(value), 100)}`;
    }
  }
}

function childrenFromDetails(details: SubagentDetails): DetailChildRef[] {
  const children: DetailChildRef[] = [];
  for (const raw of details.results ?? []) {
    const result = asRecord(raw);
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
    children.push({
      name: typeof result.name === "string" && result.name ? result.name : undefined,
      agent: typeof result.agent === "string" ? result.agent : "unknown agent",
      status: exitCode === -1 ? "running" : exitCode === 0 ? "success" : "error",
      task: typeof result.task === "string" ? result.task : "",
    });
  }
  return children;
}

export function findNameRecord(registry: NamesRegistry, name: string): SubagentNameRecord | undefined {
  const agents = registry.agents ?? {};
  const direct = agents[name];
  if (direct) return direct;
  const wanted = name.trim().toLowerCase();
  for (const [key, record] of Object.entries(agents)) {
    if (key.toLowerCase() === wanted) return record;
  }
  return undefined;
}

export interface ParsedTranscript {
  blocks: DetailBlock[];
  usage: DetailUsage;
  toolCallCount: number;
}

export function parseTranscriptMessages(messages: unknown[]): ParsedTranscript {
  const blocks: DetailBlock[] = [];
  const usage: DetailUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  let toolCallCount = 0;
  const pendingTools = new Map<string, Extract<DetailEvent, { type: "tool" }>>();

  const currentBlock = (): DetailBlock => {
    if (blocks.length === 0) {
      blocks.push({ kind: "task", index: 0, prompt: "", events: [] });
    }
    return blocks[blocks.length - 1];
  };

  for (const entry of messages) {
    const wrapper = asRecord(entry);
    const message = asRecord(wrapper.message);
    const at = parseTimestamp(wrapper.timestamp ?? message.timestamp);
    const role = message.role;

    if (role === "user") {
      const prompt = textOf(message.content).trim();
      const index = blocks.length;
      blocks.push({
        kind: index === 0 ? "task" : "resume",
        index,
        prompt,
        at,
        events: [],
      });
      continue;
    }

    if (role === "assistant") {
      usage.turns += 1;
      const assistantTurn = usage.turns;
      const messageUsage = asRecord(message.usage);
      usage.input += Number(messageUsage.input) || 0;
      usage.output += Number(messageUsage.output) || 0;
      usage.cacheRead += Number(messageUsage.cacheRead) || 0;
      usage.cacheWrite += Number(messageUsage.cacheWrite) || 0;
      const cost = messageUsage.cost;
      usage.cost += typeof cost === "number" ? cost : Number(asRecord(cost).total) || 0;

      const block = currentBlock();
      for (const rawPart of Array.isArray(message.content) ? message.content : []) {
        const part = asRecord(rawPart);
        if (part.type === "thinking" && typeof part.thinking === "string") {
          const text = part.thinking.trim();
          if (text) block.events.push({ type: "thinking", text });
        } else if (part.type === "text" && typeof part.text === "string") {
          const text = part.text.trim();
          if (text) block.events.push({ type: "text", text, assistantTurn });
        } else if (part.type === "toolCall" && typeof part.name === "string") {
          toolCallCount += 1;
          const event: Extract<DetailEvent, { type: "tool" }> = {
            type: "tool",
            name: part.name,
            preview: describeToolArgs(part.name, part.arguments),
            arguments: JSON.stringify(asRecord(part.arguments), null, 2),
          };
          block.events.push(event);
          if (typeof part.id === "string") pendingTools.set(part.id, event);
        }
      }
      continue;
    }

    if (role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "";
      const block = currentBlock();
      if (
        (isSubagentLaunchToolName(toolName) || toolName === RESUME_SUBAGENTS_TOOL_NAME) &&
        isSubagentDetails(message.details)
      ) {
        const call = typeof message.toolCallId === "string" ? pendingTools.get(message.toolCallId) : undefined;
        const children = childrenFromDetails(message.details);
        if (call) {
          const at = block.events.indexOf(call);
          if (at >= 0) block.events.splice(at, 1, { type: "children", toolName, children });
          else block.events.push({ type: "children", toolName, children });
        } else {
          block.events.push({ type: "children", toolName, children });
        }
        continue;
      }

      const call = typeof message.toolCallId === "string" ? pendingTools.get(message.toolCallId) : undefined;
      if (!call) continue;
      const output = textOf(message.content).replace(/\r\n?/g, "\n").trim();
      call.isError = Boolean(message.isError);
      if (output) call.result = output;
    }
  }

  return { blocks, usage, toolCallCount };
}

export function buildSubagentDetail(record: SubagentNameRecord, options: { sessionDir?: string } = {}): SubagentDetail {
  const sessionDir = options.sessionDir ?? record.sessionDir;
  const notes: string[] = [];
  const files = sessionFilesIn(sessionDir);
  const sessionFile = files[files.length - 1];

  let blocks: DetailBlock[] = [];
  let usage: DetailUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  let toolCallCount = 0;

  if (!sessionFile) {
    notes.push(`No session transcript found in ${shortenPath(sessionDir)}`);
  } else {
    const parsed = parseTranscriptMessages(readSessionMessages(sessionFile));
    blocks = parsed.blocks;
    usage = parsed.usage;
    toolCallCount = parsed.toolCallCount;
    if (files.length > 1) {
      notes.push(`${files.length} session files in this directory; showing the newest.`);
    }
  }

  if (blocks.length === 0 && record.task) {
    blocks = [{ kind: "task", index: 0, prompt: record.task, at: record.createdAt, events: [] }];
  }
  if (blocks.length > 0 && !blocks[0].prompt && record.task) {
    blocks[0].prompt = record.task;
  }

  return {
    name: record.name,
    agent: record.agent,
    model: record.model,
    tools: record.tools,
    createdAt: record.createdAt,
    sessionDir,
    sessionFile,
    forkCount: Object.keys(record.forks ?? {}).length,
    blocks,
    usage,
    toolCallCount,
    notes,
  };
}
