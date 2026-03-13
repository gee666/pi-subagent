/**
 * TUI rendering for subagent tool calls and results.
 */

import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import {
	type DelegationMode,
	type NestedSubagentResult,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
	DEFAULT_DELEGATION_MODE,
	aggregateUsage,
	getDisplayItems,
	getFinalOutput,
	getNestedSubagentResults,
	isResultError,
	isSubagentDetails,
} from "./types.js";

const OUTPUT_PREVIEW_LINE_COUNT = 6;

type ThemeFg = (color: string, text: string) => string;
type NodeStatus = "running" | "success" | "error";

interface TreeNode {
	label: string;
	status: NodeStatus;
	meta?: string;
	task?: string;
	outputPreview?: string[];
	children: TreeNode[];
}

interface TreeCounts {
	total: number;
	running: number;
	success: number;
	error: number;
	finished: number;
}

interface PendingSubagentCall {
	toolCallId: string;
	mode: DelegationMode;
	tasks: Array<{ agent: string; task?: string }>;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Partial<UsageStats>, model?: string): string {
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

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function normalizeDelegationMode(raw: unknown): DelegationMode {
	return raw === "fork" ? "fork" : DEFAULT_DELEGATION_MODE;
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

function statusEmoji(status: NodeStatus, theme: { fg: ThemeFg }): string {
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

function countNodes(nodes: TreeNode[]): TreeCounts {
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

function hasNestedChildren(nodes: TreeNode[]): boolean {
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
				mode: normalizeDelegationMode((args as any).mode),
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
		meta: call.mode === "fork" ? "fork" : "spawn",
		task: task.task,
		children: [],
	}));
}

function buildNodesFromNestedResult(nested: NestedSubagentResult): TreeNode[] {
	return nested.details.results.map((result) => buildResultNode(result, nested.details.delegationMode));
}

function buildNestedChildren(result: SingleResult): TreeNode[] {
	const completedByToolCallId = new Map<string, NestedSubagentResult>();
	for (const nested of getNestedSubagentResults(result.messages)) {
		completedByToolCallId.set(nested.toolCallId, nested);
	}

	const nodes: TreeNode[] = [];
	for (const call of extractPendingSubagentCalls(result.messages)) {
		const completed = completedByToolCallId.get(call.toolCallId);
		if (completed && isSubagentDetails(completed.details)) {
			nodes.push(...buildNodesFromNestedResult(completed));
			continue;
		}
		nodes.push(...buildPendingNodes(call));
	}
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
	const finalOutput = getFinalOutput(result.messages);
	if (finalOutput) lines.push(...lastNonEmptyLines(finalOutput, OUTPUT_PREVIEW_LINE_COUNT));
	const unique = lines.filter((line, index) => line && lines.indexOf(line) === index);
	return unique.length > 0 ? unique.slice(-OUTPUT_PREVIEW_LINE_COUNT) : undefined;
}

function buildResultNode(result: SingleResult, delegationMode: DelegationMode): TreeNode {
	const status = statusFromResult(result);
	const usage = formatUsage(result.usage, result.model);
	const metaParts: string[] = [result.agentSource, delegationMode];
	if (usage) metaParts.push(usage);
	if (status === "error") {
		const errorText = result.errorMessage || result.stderr || result.stopReason;
		if (errorText) metaParts.push(truncate(errorText.replace(/\s+/g, " "), 120));
	}

	const children = buildNestedChildren(result);
	return {
		label: result.agent,
		status,
		meta: metaParts.join(" • "),
		task: result.task,
		outputPreview: children.length === 0 ? buildLeafPreview(result) : undefined,
		children,
	};
}

function buildTopLevelNodes(details: SubagentDetails): TreeNode[] {
	return details.results.map((result) => buildResultNode(result, details.delegationMode));
}

function renderTreeLines(
	nodes: TreeNode[],
	theme: { fg: ThemeFg },
	showOutputPreview: boolean,
	depth = 0,
): string[] {
	const lines: string[] = [];

	for (const node of nodes) {
		const indent = "  ".repeat(depth);
		let line = `${indent}${statusEmoji(node.status, theme)} ${theme.fg("accent", node.label)}`;
		if (node.meta) line += ` ${theme.fg("dim", node.meta)}`;
		lines.push(line);

		if (showOutputPreview && node.outputPreview && node.outputPreview.length > 0) {
			for (const outputLine of node.outputPreview) {
				lines.push(`${indent}  ${theme.fg("toolOutput", outputLine)}`);
			}
		}

		if (node.children.length > 0) {
			lines.push(...renderTreeLines(node.children, theme, false, depth + 1));
		}
	}

	return lines;
}

function topLevelSummary(details: SubagentDetails, counts: TreeCounts): string {
	// aggregatedUsage includes own agents + all their nested descendants;
	// fall back to summing only direct results for old serialised data lacking the field.
	const totalUsage = formatUsage(
		details.aggregatedUsage ?? aggregateUsage(details.results),
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

// ---------------------------------------------------------------------------
// renderCall — shown while the tool is being invoked
// ---------------------------------------------------------------------------

export function renderCall(args: Record<string, any>, theme: { fg: ThemeFg; bold: (s: string) => string }): Text {
	const delegationMode = normalizeDelegationMode(args.mode);
	const tasks = Array.isArray(args.tasks) ? args.tasks : [];
	const count = tasks.length;
	let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("muted", `[${delegationMode}]`)} ${theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`)}`;
	for (const task of tasks.slice(0, 6)) {
		const agent = typeof task?.agent === "string" ? task.agent : "...";
		const preview = typeof task?.task === "string" ? ` ${truncate(task.task, 56)}` : "";
		text += `\n  ${theme.fg("warning", "⏳")} ${theme.fg("accent", agent)}${theme.fg("dim", preview)}`;
	}
	if (tasks.length > 6) text += `\n  ${theme.fg("muted", `... +${tasks.length - 6} more`)}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult — shown after the tool completes / streams updates
// ---------------------------------------------------------------------------

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	_expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container | Text {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "(no output)", 0, 0);
	}

	const nodes = buildTopLevelNodes(details);
	const counts = countNodes(nodes);
	const showOutputPreview = !hasNestedChildren(nodes);
	const icon = counts.running > 0
		? theme.fg("warning", "⏳")
		: counts.error > 0
			? theme.fg("error", "❌")
			: theme.fg("success", "✅");

	const container = new Container();
	container.addChild(
		new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold("subagent tree "))}${theme.fg("muted", `[${details.delegationMode}]`)} ${theme.fg("dim", topLevelSummary(details, counts))}`,
			0,
			0,
		),
	);

	container.addChild(new Spacer(1));
	container.addChild(new Text(renderTreeLines(nodes, theme, showOutputPreview).join("\n"), 0, 0));

	return container;
}
