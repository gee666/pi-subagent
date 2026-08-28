/**
 * Pure tree-building and line-rendering logic for the subagent TUI.
 *
 * This module deliberately has NO dependency on `@mariozechner/pi-tui` so it
 * can be unit-tested without the (peer) TUI package installed. `render.ts`
 * imports from here and wraps the produced lines in pi-tui Containers/Text.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type LiveLogEntry,
	type NestedSubagentResult,
	type SingleResult,
	MAX_LIVE_LOG_ENTRIES,
	type SubagentDetails,
	type UsageStats,
	aggregateUsage,
	getDisplayItems,
	getFinalOutput,
	getNestedSubagentResults,
	isResultError,
	isSubagentDetails,
	isSubagentToolName,
	usageSummaryToUsageStats,
} from "./types.js";

export const OUTPUT_PREVIEW_LINE_COUNT = 6;

let broadcastNumberingActive = false;

export function setBroadcastNumberingActive(active: boolean): void {
	broadcastNumberingActive = active;
}

export type ThemeFg = (color: string, text: string) => string;
export type NodeStatus = "running" | "success" | "error";

export interface TreeNode {
	label: string;
	status: NodeStatus;
	meta?: string;
	task?: string;
	/** Epoch ms when this subagent run started (rendered as a dim hh:mm:ss prefix). */
	startedAt?: number;
	/** Latest activity across this node and every descendant. */
	lastActionAt?: number;
	outputPreview?: string[];
	liveActivity?: LiveLogEntry[];
	children: TreeNode[];
}

export interface TreeCounts {
	total: number;
	running: number;
	success: number;
	error: number;
	finished: number;
}

interface PendingSubagentCall {
	toolCallId: string;
	tasks: Array<{ agent: string; task?: string }>;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

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

export function formatCombinedUsageStatusLine(
	usage: Partial<UsageStats>,
	subagentCount: number,
): string {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const turns = usage.turns ?? 0;
	const cost = usage.cost ?? 0;
	const total = input + output + cacheRead + cacheWrite;
	const cache = cacheRead || cacheWrite
		? ` R${formatTokens(cacheRead)} W${formatTokens(cacheWrite)}`
		: "";
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

function statusFromResult(result: SingleResult): NodeStatus {
	if (result.exitCode === -1) return "running";
	return isResultError(result) ? "error" : "success";
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

function extractPendingSubagentCalls(messages: SingleResult["messages"] | unknown): PendingSubagentCall[] {
	const history = Array.isArray(messages) ? messages : [];
	const calls: PendingSubagentCall[] = [];
	for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
		const message = history[messageIndex] as any;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
			const part = message.content[partIndex] as any;
			if (part?.type !== "toolCall" || !isSubagentToolName(part?.name)) continue;
			const args = part.arguments && typeof part.arguments === "object" ? part.arguments : {};
			const tasks = Array.isArray((args as any).tasks)
				? (args as any).tasks
						.filter((task: any) => task && typeof task.agent === "string")
						.map((task: any) => ({
							agent: task.agent,
							task: typeof task.task === "string" ? task.task : undefined,
						}))
				: (args as any).resumes
					? (Array.isArray((args as any).resumes) ? (args as any).resumes : [(args as any).resumes])
							// Current shape is {subagent, task}; tolerate legacy {name, prompt}.
							.map((resume: any) => ({
								agent: typeof resume?.subagent === "string" ? resume.subagent : resume?.name,
								task: typeof resume?.task === "string" ? resume.task : typeof resume?.prompt === "string" ? resume.prompt : undefined,
							}))
							.filter((entry: any) => typeof entry.agent === "string")
					: [];
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
	return JSON.stringify(details.results.map((result) => {
		const value = asRecord(result);
		return { agent: stringValue(value.agent), task: stringValue(value.task) };
	}));
}

function findLiveNestedDetailsForCall(
	result: SingleResult,
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

	// Some pi versions pass a different internal id to Tool.execute than the id
	// stored on the assistant toolCall part. Final toolResult messages still line
	// up by id, but live `subagent_progress` events can be keyed differently. In
	// that case match the running nested tree by the requested agent/task
	// signature so grandchildren render live instead of falling back to static
	// pending placeholders.
	const signature = subagentCallSignature(call);
	for (const [key, details] of Object.entries(live)) {
		if (usedLiveKeys.has(key) || !isSubagentDetails(details)) continue;
		if (buildLiveDetailsSignature(details) !== signature) continue;
		usedLiveKeys.add(key);
		return details;
	}

	// Fallback for cases where task text differs slightly by the time the child
	// details are emitted. Still require the same agent sequence; count-only
	// matching can attach progress to the wrong repeated/concurrent call.
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

function buildNestedChildren(result: SingleResult, hydrateSessions: boolean): TreeNode[] {
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
		// A resumed call has the same task signature as the interrupted call but a
		// newer toolCallId. Prefer that newer running/successful tree over the old
		// synthetic/aborted result so resumed nested subagents render in-place.
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

		const liveDetails = parentIsRunning
			? findLiveNestedDetailsForCall(result, call, usedLiveKeys)
			: undefined;
		if (liveDetails) {
			nodes.push(...buildNodesFromDetails(liveDetails, hydrateSessions));
			return;
		}

		// Unmatched subagent tool calls are useful while the parent is still
		// running (they show live pending children). Once the parent finished,
		// unmatched calls are stale history from an interrupted/resumed session and
		// must not keep the whole tree in a perpetual "running" state.
		if (parentIsRunning) nodes.push(...buildPendingNodes(call));
	});
	return nodes;
}

function formatToolArgPreview(toolName: unknown, rawArgs: unknown): string {
	const args = asRecord(rawArgs);
	const shorten = (value: unknown) => {
		const p = stringValue(value);
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const truncateTo = (value: unknown, n: number) => {
		const text = stringValue(value);
		return text.length > n ? text.slice(0, n) + "\u2026" : text;
	};

	switch (toolName) {
		case "bash":
			return truncateTo(stringValue(args.command).replace(/\s+/g, " "), 52);
		case "read":
		case "write":
		case "edit":
			return shorten(truncateTo(args.path ?? args.file_path, 52));
		case "grep": {
			const pattern = stringValue(args.pattern);
			const target = stringValue(args.path);
			return truncateTo(`/${pattern}/`, 30) + (target ? ` in ${shorten(target)}` : "");
		}
		case "find": {
			const pattern = stringValue(args.pattern, "*");
			const target = stringValue(args.path);
			return truncateTo(pattern, 30) + (target ? ` in ${shorten(target)}` : "");
		}
		case "subagent":
		case "subagents": {
			const tasks = Array.isArray(args.tasks) ? args.tasks : [];
			return tasks
				.map((task) => stringValue(asRecord(task).agent))
				.filter(Boolean)
				.join(", ");
		}
		case "resume_subagents": {
			const raw = args.resumes;
			const resumes = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
			return resumes
				.map((resume) => {
					const item = asRecord(resume);
					return stringValue(item.subagent) || stringValue(item.name);
				})
				.filter(Boolean)
				.join(", ");
		}
		default:
			return "";
	}
}

export function formatLiveLogEntry(
	entry: LiveLogEntry,
	theme: { fg: ThemeFg },
): string {
	const value = asRecord(entry);
	const at = typeof value.at === "number" && Number.isFinite(value.at) ? value.at : undefined;
	const stamp = at !== undefined ? theme.fg("dim", formatClockTime(at)) + " " : "";
	return stamp + formatLiveLogEntryBody(value, theme);
}

function formatLiveLogEntryBody(
	entry: Record<string, unknown>,
	theme: { fg: ThemeFg },
): string {
	switch (entry.kind) {
		case "turn_start":
			return theme.fg("muted", "\u27f3") + " " + theme.fg("dim", "thinking\u2026");

		case "turn_end": {
			const inputTokens = finiteNumber(entry.inputTokens);
			const outputTokens = finiteNumber(entry.outputTokens);
			const tokens = inputTokens || outputTokens
				? " " + theme.fg("dim",
					`\u2191${formatTokens(inputTokens)} \u2193${formatTokens(outputTokens)}`)
				: "";
			const turn = finiteNumber(entry.turn);
			return (
				theme.fg("success", "\u2713") +
				" " +
				theme.fg("muted", `turn ${turn}`) +
				tokens
			);
		}

		case "tool_start": {
			const toolName = stringValue(entry.toolName, "unknown tool");
			const argPreview = formatToolArgPreview(toolName, entry.args);
			return (
				theme.fg("muted", "\u2192") +
				" " +
				theme.fg("accent", toolName) +
				(argPreview ? "  " + theme.fg("dim", argPreview) : "")
			);
		}

		case "tool_end":
			return (
				theme.fg("success", "\u2713") +
				" " +
				theme.fg("accent", stringValue(entry.toolName, "unknown tool"))
			);

		default:
			return theme.fg("muted", "activity");
	}
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

function latestSessionFile(sessionDir: string): string | undefined {
	try {
		const entries = fs.readdirSync(sessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => {
				const file = path.join(sessionDir, name);
				const stat = fs.statSync(file);
				return { file, mtimeMs: stat.mtimeMs };
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return entries[0]?.file;
	} catch {
		return undefined;
	}
}

function loadNestedNodesFromSession(sessionDir: string): TreeNode[] {
	const file = latestSessionFile(sessionDir);
	if (!file) return [];

	const messages: SingleResult["messages"] = [];
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let entry: any;
			try { entry = JSON.parse(line); } catch { continue; }
			if (entry?.type === "message" && entry.message) messages.push(entry.message);
		}
	} catch {
		return [];
	}

	// Parse the transcript into compact display nodes, then let the potentially
	// very large messages array become unreachable immediately.
	return buildNestedChildren({
		agent: "session",
		agentSource: "unknown",
		task: "",
		exitCode: 0,
		messages,
		stderr: "",
		usage: {} as UsageStats,
		toolCalls: {},
		completedTurns: 0,
		turnInProgress: false,
		liveLog: [],
	}, true);
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
			usage: {} as UsageStats,
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
	const ownLastAction = typeof result.lastActionAt === "number" && Number.isFinite(result.lastActionAt)
		? result.lastActionAt
		: liveLog.reduce((latest, entry) => Math.max(latest, typeof entry.at === "number" ? entry.at : 0), result.startedAt ?? 0);
	const descendantLastAction = children.reduce((latest, child) => Math.max(latest, child.lastActionAt ?? 0), 0);
	const agentType = stringValue(result.agent, "unknown agent");
	const humanName = typeof result.name === "string" && result.name ? result.name : undefined;
	return {
		label: humanName ? `${humanName} (${agentType})` : agentType,
		status,
		meta: metaParts.join(" • "),
		task: typeof result.task === "string" ? result.task : undefined,
		startedAt: typeof result.startedAt === "number" && Number.isFinite(result.startedAt)
			? result.startedAt
			: undefined,
		lastActionAt: Math.max(ownLastAction, descendantLastAction) || undefined,
		liveActivity: isRunning && liveLog.length > 0 ? liveLog.slice(-MAX_LIVE_LOG_ENTRIES) : undefined,
		outputPreview: !isRunning && children.length === 0 ? buildLeafPreview(result) : undefined,
		children,
	};
}

export function buildTopLevelNodes(
	details: SubagentDetails,
	options: { hydrateSessions?: boolean } = {},
): TreeNode[] {
	return details.results.map((result) => buildResultNode(result, options.hydrateSessions !== false));
}

export function renderTreeLines(
	nodes: TreeNode[],
	theme: { fg: ThemeFg },
	showOutputPreview: boolean,
	depth = 0,
	prefix = "",
	showFullPrompts = false,
): string[] {
	const lines: string[] = [];

	nodes.forEach((node, index) => {
		const indent = "  ".repeat(depth);
		const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
		const numberPrefix = broadcastNumberingActive ? `${number}. ` : "";
		const timePrefix = node.startedAt !== undefined
			? `${theme.fg("dim", formatClockTime(node.startedAt))} `
			: "";
		let line = `${indent}${numberPrefix}${timePrefix}${statusEmoji(node.status, theme)} ${theme.fg("accent", node.label)}`;
		if (node.meta) line += ` ${theme.fg("dim", node.meta)}`;
		lines.push(line);

		if (showFullPrompts && node.task) {
			const promptLines = node.task.replace(/\r\n?/g, "\n").split("\n");
			promptLines.forEach((promptLine, promptIndex) => {
				const promptLabel = promptIndex === 0 ? "prompt: " : "        ";
				lines.push(`${indent}  ${theme.fg("muted", promptLabel)}${theme.fg("toolOutput", promptLine)}`);
			});
		}

		if (showOutputPreview && node.outputPreview && node.outputPreview.length > 0) {
			for (const outputLine of node.outputPreview) {
				lines.push(`${indent}  ${theme.fg("toolOutput", outputLine)}`);
			}
		}

		// Live activity (thinking / tool calls of a *running* agent) is always
		// shown, at any depth and regardless of `showOutputPreview`. Previously it
		// was gated behind `showOutputPreview`, which is disabled for the whole
		// tree as soon as any nesting exists — so teamlead/nested runs showed only
		// static status lines and looked frozen. liveActivity is only attached to
		// running nodes (see buildResultNode), so completed nodes stay quiet.
		if (node.liveActivity && node.liveActivity.length > 0) {
			for (const entry of node.liveActivity) {
				lines.push(`${indent}  ${formatLiveLogEntry(entry, theme)}`);
			}
		}

		if (node.children.length > 0) {
			lines.push(...renderTreeLines(node.children, theme, showOutputPreview, depth + 1, number, showFullPrompts));
		}
	});

	return lines;
}

export function topLevelSummary(
	details: SubagentDetails,
	counts: TreeCounts,
	options: { directOnly?: boolean } = {},
): string {
	// aggregatedUsage includes own agents + all their nested descendants;
	// fall back to summing only direct results for old serialised data lacking the field.
	const safeResults = details.results.filter(
		(result): result is SingleResult => result !== null && typeof result === "object" && !Array.isArray(result),
	);
	const totalUsage = formatUsage(
		usageSummaryToUsageStats(details.usageSummary) ?? details.aggregatedUsage ?? aggregateUsage(safeResults),
	);
	const historicalTotal = options.directOnly
		? Math.max(counts.total, details.usageSummary?.subagentCount ?? 0)
		: counts.total;
	const historicalFinished = options.directOnly && counts.running === 0
		? historicalTotal
		: counts.finished;
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
