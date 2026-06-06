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
	type SubagentDetails,
	type UsageStats,
	aggregateUsage,
	getDisplayItems,
	getFinalOutput,
	getNestedSubagentResults,
	isResultError,
	isSubagentDetails,
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

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
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
	return `Σ ↑${formatTokens(input)} ↓${formatTokens(output)}${cache} T${formatTokens(total)} • ${turns} turn${turns === 1 ? "" : "s"} • $${cost.toFixed(4)} • ${subagentCount} subagent${subagentCount === 1 ? "" : "s"}`;
}

export function formatUsage(usage: Partial<UsageStats>, model?: string): string {
	const parts: string[] = [];
	const totalTokens =
		(usage.input || 0) +
		(usage.output || 0) +
		(usage.cacheRead || 0) +
		(usage.cacheWrite || 0);
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (totalTokens > 0) parts.push(`tok:${formatTokens(totalTokens)}`);
	if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`cacheR:${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`cacheW:${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" • ");
}

export function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function splitOutputLines(text: string): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function lastNonEmptyLines(text: string, limit: number): string[] {
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

function extractPendingSubagentCalls(messages: SingleResult["messages"]): PendingSubagentCall[] {
	const calls: PendingSubagentCall[] = [];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex] as any;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
			const part = message.content[partIndex] as any;
			if (part?.type !== "toolCall" || part?.name !== "subagent") continue;
			const args = part.arguments && typeof part.arguments === "object" ? part.arguments : {};
			const tasks = Array.isArray((args as any).tasks)
				? (args as any).tasks
						.filter((task: any) => task && typeof task.agent === "string")
						.map((task: any) => ({
							agent: task.agent,
							task: typeof task.task === "string" ? task.task : undefined,
						}))
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

function buildNodesFromDetails(details: SubagentDetails): TreeNode[] {
	return details.results.map((result) => buildResultNode(result));
}

function buildNodesFromNestedResult(nested: NestedSubagentResult): TreeNode[] {
	return buildNodesFromDetails(nested.details);
}

function subagentCallSignature(call: PendingSubagentCall): string {
	return JSON.stringify(call.tasks.map((task) => ({ agent: task.agent, task: task.task ?? "" })));
}

function nestedResultIsHealthy(nested: NestedSubagentResult | undefined): boolean {
	if (!nested || nested.isError) return false;
	return nested.details.results.every((result) => !isResultError(result));
}

function buildLiveDetailsSignature(details: SubagentDetails): string {
	return JSON.stringify(details.results.map((result) => ({ agent: result.agent, task: result.task ?? "" })));
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
		const liveAgentSignature = JSON.stringify(details.results.map((nestedResult) => nestedResult.agent));
		if (liveAgentSignature !== agentSignature) continue;
		usedLiveKeys.add(key);
		return details;
	}

	return undefined;
}

function buildNestedChildren(result: SingleResult): TreeNode[] {
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
			nodes.push(...buildNodesFromNestedResult(completed));
			return;
		}

		const liveDetails = parentIsRunning
			? findLiveNestedDetailsForCall(result, call, usedLiveKeys)
			: undefined;
		if (liveDetails) {
			nodes.push(...buildNodesFromDetails(liveDetails));
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

function formatToolArgPreview(toolName: string, args: Record<string, unknown>): string {
	const shorten = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const truncateTo = (s: string, n: number) =>
		s.length > n ? s.slice(0, n) + "\u2026" : s;

	switch (toolName) {
		case "bash": {
			const cmd = (args.command as string) || "";
			return truncateTo(cmd.replace(/\s+/g, " "), 52);
		}
		case "read":
		case "write":
		case "edit":
			return shorten(truncateTo((args.path ?? args.file_path ?? "") as string, 52));
		case "grep":
			return truncateTo(`/${args.pattern}/`, 30) +
				   (args.path ? ` in ${shorten(args.path as string)}` : "");
		case "find":
			return truncateTo((args.pattern ?? "*") as string, 30) +
				   (args.path ? ` in ${shorten(args.path as string)}` : "");
		case "subagent": {
			const tasks = (args.tasks as any[]) ?? [];
			return tasks.map((t: any) => t.agent).join(", ");
		}
		default:
			return "";
	}
}

export function formatLiveLogEntry(
	entry: LiveLogEntry,
	theme: { fg: ThemeFg },
): string {
	switch (entry.kind) {
		case "turn_start":
			return theme.fg("muted", "\u27f3") + " " + theme.fg("dim", "thinking\u2026");

		case "turn_end": {
			const tokens = entry.inputTokens || entry.outputTokens
				? " " + theme.fg("dim",
					`\u2191${formatTokens(entry.inputTokens)} \u2193${formatTokens(entry.outputTokens)}`)
				: "";
			return (
				theme.fg("success", "\u2713") +
				" " +
				theme.fg("muted", `turn ${entry.turn}`) +
				tokens
			);
		}

		case "tool_start": {
			const argPreview = formatToolArgPreview(entry.toolName, entry.args);
			return (
				theme.fg("muted", "\u2192") +
				" " +
				theme.fg("accent", entry.toolName) +
				(argPreview ? "  " + theme.fg("dim", argPreview) : "")
			);
		}

		case "tool_end":
			return (
				theme.fg("success", "\u2713") +
				" " +
				theme.fg("accent", entry.toolName)
			);
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

const sessionMessageCache = new Map<string, { mtimeMs: number; messages: SingleResult["messages"] }>();

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

function loadMessagesFromSession(sessionDir: string | undefined): SingleResult["messages"] {
	if (!sessionDir) return [];
	const file = latestSessionFile(sessionDir);
	if (!file) return [];
	let mtimeMs = 0;
	try { mtimeMs = fs.statSync(file).mtimeMs; } catch { return []; }
	const cached = sessionMessageCache.get(file);
	if (cached && cached.mtimeMs === mtimeMs) return cached.messages;

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
	sessionMessageCache.set(file, { mtimeMs, messages });
	return messages;
}

function hydrateResultFromSession(result: SingleResult): SingleResult {
	if (result.messages?.length > 0) return result;
	const messages = loadMessagesFromSession(result.sessionDir);
	return messages.length > 0 ? { ...result, messages } : result;
}

function buildResultNode(result: SingleResult): TreeNode {
	result = hydrateResultFromSession(result);
	const status = statusFromResult(result);
	const usage = formatUsage(result.usage ?? {}, result.model);
	const metaParts: string[] = [result.agentSource];
	if (usage) metaParts.push(usage);
	if (status === "error") {
		const errorText = result.errorMessage || result.stderr || result.stopReason;
		if (errorText) metaParts.push(truncate(errorText.replace(/\s+/g, " "), 120));
	}

	const children = buildNestedChildren(result);
	const isRunning = status === "running";
	return {
		label: result.agent,
		status,
		meta: metaParts.join(" • "),
		task: result.task,
		liveActivity: isRunning && (result.liveLog?.length ?? 0) > 0 ? result.liveLog : undefined,
		outputPreview: !isRunning && children.length === 0 ? buildLeafPreview(result) : undefined,
		children,
	};
}

export function buildTopLevelNodes(details: SubagentDetails): TreeNode[] {
	return details.results.map((result) => buildResultNode(result));
}

export function renderTreeLines(
	nodes: TreeNode[],
	theme: { fg: ThemeFg },
	showOutputPreview: boolean,
	depth = 0,
	prefix = "",
): string[] {
	const lines: string[] = [];

	nodes.forEach((node, index) => {
		const indent = "  ".repeat(depth);
		const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
		const numberPrefix = broadcastNumberingActive ? `${number}. ` : "";
		let line = `${indent}${numberPrefix}${statusEmoji(node.status, theme)} ${theme.fg("accent", node.label)}`;
		if (node.meta) line += ` ${theme.fg("dim", node.meta)}`;
		lines.push(line);

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
			lines.push(...renderTreeLines(node.children, theme, showOutputPreview, depth + 1, number));
		}
	});

	return lines;
}

export function topLevelSummary(details: SubagentDetails, counts: TreeCounts): string {
	// aggregatedUsage includes own agents + all their nested descendants;
	// fall back to summing only direct results for old serialised data lacking the field.
	const totalUsage = formatUsage(
		usageSummaryToUsageStats(details.usageSummary) ?? details.aggregatedUsage ?? aggregateUsage(details.results),
	);
	const parts = [
		`${counts.running} running`,
		`${counts.finished}/${counts.total} finished`,
		`${counts.success} ok`,
		`${counts.error} error`,
	];
	if (totalUsage) parts.push(totalUsage);
	return parts.join(" • ");
}
