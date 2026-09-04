/**
 * Full-detail view of ONE named subagent, built from its own session file.
 *
 * This module is intentionally free of any `@mariozechner/pi-tui` dependency so
 * it can be unit-tested standalone (like `tree.ts`). It produces:
 *
 *   1. a structured model (`buildSubagentDetail`) parsed from the subagent's
 *      session transcript, and
 *   2. plain (optionally ANSI-coloured) lines (`renderDetailLines`) that the
 *      overlay pager can window and scroll.
 *
 * It is only ever invoked from the `/subagent-expand <name>` command, never
 * from a render frame, so reading a whole transcript here is acceptable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { NamesRegistry, SubagentNameRecord } from "./names.js";
import {
	type SubagentDetails,
	isSubagentDetails,
	isSubagentLaunchToolName,
	RESUME_SUBAGENTS_TOOL_NAME,
} from "./types.js";
import { type ThemeFg, formatClockTime, formatTokens, truncate } from "./tree.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface DetailChildRef {
	/** Human name of the child subagent, when known. */
	name?: string;
	agent: string;
	status: "running" | "success" | "error";
	task: string;
}

export type DetailEvent =
	| { type: "thinking"; text: string }
	| { type: "text"; text: string; assistantTurn?: number }
	| { type: "tool"; name: string; preview: string; arguments: string; isError?: boolean; result?: string }
	| { type: "children"; toolName: string; children: DetailChildRef[] };

export interface DetailBlock {
	/** "task" for the initial prompt, "resume" for every later prompt. */
	kind: "task" | "resume";
	/** 0 for the initial task, 1..N for resumes. */
	index: number;
	prompt: string;
	at?: number;
	events: DetailEvent[];
}

export interface DetailUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface SubagentDetail {
	name: string;
	agent: string;
	model?: string;
	tools?: string[];
	createdAt?: number;
	sessionDir: string;
	sessionFile?: string;
	forkCount: number;
	blocks: DetailBlock[];
	usage: DetailUsage;
	toolCallCount: number;
	notes: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, any> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, any>)
		: {};
}

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

/** Compact one-line preview of a tool call's arguments. */
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

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

/** All `.jsonl` session files in a directory, newest last. */
export function sessionFilesIn(sessionDir: string): string[] {
	try {
		return fs
			.readdirSync(sessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => {
				const file = path.join(sessionDir, name);
				return { file, mtimeMs: fs.statSync(file).mtimeMs };
			})
			.sort((a, b) => a.mtimeMs - b.mtimeMs)
			.map((entry) => entry.file);
	} catch {
		return [];
	}
}

/** Find a name record case-insensitively. */
export function findNameRecord(
	registry: NamesRegistry,
	name: string,
): SubagentNameRecord | undefined {
	const agents = registry.agents ?? {};
	const direct = agents[name];
	if (direct) return direct;
	const wanted = name.trim().toLowerCase();
	for (const [key, record] of Object.entries(agents)) {
		if (key.toLowerCase() === wanted) return record;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

export interface ParsedTranscript {
	blocks: DetailBlock[];
	usage: DetailUsage;
	toolCallCount: number;
}

/** Parse the messages of a subagent session into prompt-delimited blocks. */
export function parseTranscriptMessages(messages: unknown[]): ParsedTranscript {
	const blocks: DetailBlock[] = [];
	const usage: DetailUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	let toolCallCount = 0;
	/** toolCallId -> event, so tool results can be attached to their call. */
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

			// Nested delegation: replace the raw tool line with collapsed child rows.
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

/** Read a session `.jsonl` file and return its message entries. */
export function readSessionMessages(file: string): unknown[] {
	const messages: unknown[] = [];
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return messages;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type === "message" && entry.message) messages.push(entry);
	}
	return messages;
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------

export function buildSubagentDetail(
	record: SubagentNameRecord,
	options: { sessionDir?: string } = {},
): SubagentDetail {
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

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

export interface DetailTheme {
	fg: ThemeFg;
	bold: (text: string) => string;
}

const PLAIN_THEME: DetailTheme = { fg: (_color, text) => text, bold: (text) => text };

/** Hard-wrap plain (ANSI-free) text; colour is applied per produced line. */
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

export type TurnToolEvent = Extract<DetailEvent, { type: "tool" | "children" }>;

export function getTurnTools(block: DetailBlock | undefined): TurnToolEvent[] {
	return block?.events.filter((event): event is TurnToolEvent => event.type === "tool" || event.type === "children") ?? [];
}

/** Distinct direct children launched/resumed by this agent across every turn. */
export function getDetailChildren(detail: SubagentDetail): DetailChildRef[] {
	const children = new Map<string, DetailChildRef>();
	for (const block of detail.blocks) {
		for (const event of getTurnTools(block)) {
			if (event.type !== "children") continue;
			for (const child of event.children) {
				const key = child.name ? `name:${child.name.toLowerCase()}` : `agent:${child.agent.toLowerCase()}:${child.task}`;
				children.set(key, child);
			}
		}
	}
	return [...children.values()];
}

export function getTurnResponse(block: DetailBlock | undefined): string {
	if (!block) return "";
	let finalText: Extract<DetailEvent, { type: "text" }> | undefined;
	for (let index = block.events.length - 1; index >= 0; index--) {
		const event = block.events[index];
		if (event.type === "text" && event.text.trim()) {
			finalText = event;
			break;
		}
	}
	if (!finalText) return "";
	if (finalText.assistantTurn === undefined) return finalText.text.trim();
	return block.events
		.filter((event): event is Extract<DetailEvent, { type: "text" }> =>
			event.type === "text" && event.assistantTurn === finalText!.assistantTurn && Boolean(event.text.trim()))
		.map((event) => event.text.trim())
		.join("\n");
}

function makeLineWriter(width: number, theme: DetailTheme) {
	const lines: string[] = [];
	return {
		lines,
		push: (text = "") => lines.push(text),
		wrap: (text: string, indent = "", color?: string) => {
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
		: event.toolName === RESUME_SUBAGENTS_TOOL_NAME ? "resume subagents" : "subagents";
}

function toolPreview(event: TurnToolEvent): string {
	if (event.type === "tool") return event.preview;
	return event.children.map((child) => child.name ?? child.agent).join(", ");
}

function toolIsError(event: TurnToolEvent): boolean {
	return event.type === "tool"
		? Boolean(event.isError)
		: event.children.some((child) => child.status === "error");
}

/** Render one task/resume turn: prompt, final response, compact tools and children. */
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
	].filter(Boolean).join(" • ");
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
			const task = child.task ? ` — ${truncate(child.task.replace(/\s+/g, " "), Math.max(24, width - label.length - 13))}` : "";
			out.push(`  ${branch} ${statusIcon(child.status)} ${theme.fg("accent", label)}${theme.fg("dim", task)}`);
		});
		out.wrap("Press C to select and expand a child", "  ", "muted");
	}

	return out.lines;
}

/**
 * One selectable row of the tool list. Child subagent rows are selectable too,
 * so the tree under a delegation tool can be navigated and entered.
 */
export type ToolListRow =
	| { kind: "tool"; toolIndex: number; event: TurnToolEvent }
	| { kind: "child"; toolIndex: number; child: DetailChildRef };

export function getToolListRows(block: DetailBlock | undefined): ToolListRow[] {
	const rows: ToolListRow[] = [];
	getTurnTools(block).forEach((event, toolIndex) => {
		rows.push({ kind: "tool", toolIndex, event });
		if (event.type === "children") {
			for (const child of event.children) rows.push({ kind: "child", toolIndex, child });
		}
	});
	return rows;
}

/** Number of leading content lines before the first selectable row. */
export const TOOL_LIST_HEADER_LINES = 2;

/** Render the compact selectable tool list for one turn. */
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
			out.push(`${marker} ${String(row.toolIndex + 1).padStart(2)} ${icon} ${theme.fg("accent", toolLabel(row.event))}${preview ? ` ${theme.fg("dim", truncate(preview.replace(/\s+/g, " "), Math.max(16, width - 18)))}` : ""}`);
			return;
		}
		const siblings = rows.filter((other) => other.kind === "child" && other.toolIndex === row.toolIndex);
		const isLast = siblings[siblings.length - 1] === row;
		const label = row.child.name ? `${row.child.name} (${row.child.agent})` : row.child.agent;
		const hint = row.child.name ? theme.fg("muted", " ← Enter to expand") : theme.fg("muted", " (no name)");
		out.push(`${marker}      ${isLast ? "└─" : "├─"} ${statusIcon(row.child.status)} ${theme.fg("accent", label)}${index === selectedRow ? hint : ""}`);
	});
	return out.lines;
}

/** Render a selectable minimal tree of this agent's direct children. */
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
		const task = child.task ? ` — ${truncate(child.task.replace(/\s+/g, " "), Math.max(16, width - label.length - 12))}` : "";
		out.push(`${marker} ${branch} ${statusIcon(child.status)} ${theme.fg("accent", label)}${theme.fg("dim", task)}`);
	});
	return out.lines;
}

/** Render complete arguments/results for one selected tool call. */
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
	out.push(`${failed ? theme.fg("error", "✗") : theme.fg("success", "✓")} ${theme.bold(theme.fg("accent", `Tool ${toolIndex + 1}: ${toolLabel(event)}`))}`);

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

/** Backward-compatible plain renderer: the latest turn overview only. */
export function renderDetailLines(
	detail: SubagentDetail,
	width: number,
	theme: DetailTheme = PLAIN_THEME,
): string[] {
	return renderTurnOverviewLines(detail, Math.max(0, detail.blocks.length - 1), width, theme);
}
