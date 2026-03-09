/**
 * TUI rendering for subagent tool calls and results.
 */

import * as os from "node:os";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import {
	type DelegationMode,
	type DisplayItem,
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
} from "./types.js";

const COLLAPSED_LINE_COUNT = 10;
const COLLAPSED_PARALLEL_LINE_COUNT = 5;
const NESTED_PREVIEW_LINE_COUNT = 6;

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
	if (totalTokens > 0) parts.push(`tokens:${formatTokens(totalTokens)}`);
	if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`cacheR:${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`cacheW:${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`cost:$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function truncate(text: string, maxLen: number): string {
	return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function normalizeDelegationMode(raw: unknown): DelegationMode {
	return raw === "fork" ? "fork" : DEFAULT_DELEGATION_MODE;
}

type ThemeFg = (color: string, text: string) => string;

function firstNonEmptyLine(text: string): string {
	for (const line of splitOutputLines(text)) {
		if (line.trim()) return line.trim();
	}
	return "";
}

function formatToolCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
	const pathArg = (args.file_path || args.path || "...") as string;

	switch (toolName) {
		case "subagent": {
			const mode = normalizeDelegationMode(args.mode);
			const tasks = Array.isArray(args.tasks) ? args.tasks : [];
			if (tasks.length > 1) {
				const agents = tasks
					.slice(0, 3)
					.map((task) => typeof task?.agent === "string" ? task.agent : "...")
					.join(", ");
				const extra = tasks.length > 3 ? ` +${tasks.length - 3}` : "";
				return fg("toolTitle", "subagent ") + fg("accent", `parallel (${tasks.length})`) + fg("muted", ` [${mode}]`) + fg("dim", agents ? ` ${agents}${extra}` : "");
			}
			const task = tasks[0] as { agent?: string; task?: string } | undefined;
			return fg("toolTitle", "subagent ") + fg("accent", task?.agent || "...") + fg("muted", ` [${mode}]`) + fg("dim", task?.task ? ` ${truncate(task.task, 48)}` : "");
		}
		case "bash": {
			const cmd = (args.command as string) || "...";
			return fg("muted", "$ ") + fg("toolOutput", truncate(cmd, 60));
		}
		case "read": {
			let text = fg("accent", shortenPath(pathArg));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				text += fg("warning", `:${start}${end ? `-${end}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const lines = ((args.content || "") as string).split("\n").length;
			let text = fg("muted", "write ") + fg("accent", shortenPath(pathArg));
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit":
			return fg("muted", "edit ") + fg("accent", shortenPath(pathArg));
		case "ls":
			return fg("muted", "ls ") + fg("accent", shortenPath((args.path || ".") as string));
		case "find":
			return fg("muted", "find ") + fg("accent", (args.pattern || "*") as string) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		case "grep":
			return fg("muted", "grep ") + fg("accent", `/${(args.pattern || "") as string}/`) + fg("dim", ` in ${shortenPath((args.path || ".") as string)}`);
		default:
			return fg("accent", toolName) + fg("dim", ` ${truncate(JSON.stringify(args), 50)}`);
	}
}

// ---------------------------------------------------------------------------
// Shared rendering building blocks
// ---------------------------------------------------------------------------

function splitOutputLines(text: string): string[] {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function countDisplayLines(items: DisplayItem[]): number {
	let count = 0;
	for (const item of items) {
		count += item.type === "text" ? splitOutputLines(item.text).length : 1;
	}
	return count;
}

function renderDisplayItems(
	items: DisplayItem[],
	expanded: boolean,
	theme: { fg: ThemeFg },
	limit?: number,
): string {
	const lines: string[] = [];
	for (const item of items) {
		if (item.type === "text") {
			for (const line of splitOutputLines(item.text)) {
				lines.push(theme.fg("toolOutput", line));
			}
		} else {
			lines.push(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)));
		}
	}

	const shouldTail = !expanded && typeof limit === "number";
	const toShow = shouldTail ? lines.slice(-limit) : lines;
	const skipped = shouldTail && lines.length > limit ? lines.length - limit : 0;

	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier lines\n`);
	text += toShow.join("\n");
	return text.trimEnd();
}

function statusIcon(r: SingleResult, theme: { fg: ThemeFg }): string {
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	return isResultError(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function parallelStatus(details: SubagentDetails): {
	icon: string;
	status: string;
	isRunning: boolean;
} {
	const running = details.results.filter((r) => r.exitCode === -1).length;
	const successCount = details.results.filter((r) => r.exitCode === 0).length;
	const failCount = details.results.filter((r) => r.exitCode > 0).length;
	const isRunning = running > 0;
	const icon = isRunning ? "⏳" : failCount > 0 ? "◐" : "✓";
	const status = isRunning
		? `${successCount + failCount}/${details.results.length} done, ${running} running`
		: `${successCount}/${details.results.length} tasks`;
	return { icon, status, isRunning };
}

function renderNestedDelegationLines(
	items: NestedSubagentResult[],
	theme: { fg: ThemeFg },
	expanded: boolean,
	depth = 0,
): string[] {
	const lines: string[] = [];
	for (const item of items) {
		lines.push(...renderNestedDetailsLines(item.details, theme, expanded, depth));
	}
	return lines;
}

function renderNestedDetailsLines(
	details: SubagentDetails,
	theme: { fg: ThemeFg },
	expanded: boolean,
	depth = 0,
): string[] {
	const indent = "  ".repeat(depth);
	if (details.mode === "single") {
		const result = details.results[0];
		if (!result) return [];

		const lines: string[] = [];
		let header = `${indent}${theme.fg("muted", "↳ ")}${theme.fg("toolTitle", "subagent ")}${theme.fg("accent", result.agent)} ${statusIcon(result, theme)}${theme.fg("muted", ` [${details.delegationMode}]`)}`;
		const usage = formatUsage(result.usage, result.model);
		if (usage) header += ` ${theme.fg("dim", usage)}`;
		lines.push(header);

		if (!expanded) return lines;

		lines.push(`${indent}  ${theme.fg("muted", "task: ")}${theme.fg("dim", truncate(result.task, 96))}`);
		const nested = getNestedSubagentResults(result.messages);
		if (nested.length > 0) {
			lines.push(...renderNestedDelegationLines(nested, theme, true, depth + 1));
		}
		const finalLine = firstNonEmptyLine(getFinalOutput(result.messages));
		if (finalLine) {
			lines.push(`${indent}  ${theme.fg("muted", "final: ")}${theme.fg("toolOutput", truncate(finalLine, 96))}`);
		}
		return lines;
	}

	const { icon, status } = parallelStatus(details);
	const lines: string[] = [];
	let header = `${indent}${theme.fg("muted", "↳ ")}${theme.fg("toolTitle", "parallel delegation ")}${theme.fg("accent", status)} ${theme.fg("muted", `[${details.delegationMode}]`)} ${theme.fg(icon === "✓" ? "success" : icon === "⏳" ? "warning" : "warning", icon)}`;
	const totalUsage = formatUsage(aggregateUsage(details.results));
	if (totalUsage) header += ` ${theme.fg("dim", totalUsage)}`;
	lines.push(header);

	for (const result of details.results) {
		let line = `${indent}  ${statusIcon(result, theme)} ${theme.fg("accent", result.agent)}`;
		const usage = formatUsage(result.usage, result.model);
		if (usage) line += ` ${theme.fg("dim", usage)}`;
		lines.push(line);
		if (expanded) {
			lines.push(`${indent}    ${theme.fg("muted", "task: ")}${theme.fg("dim", truncate(result.task, 88))}`);
			const nested = getNestedSubagentResults(result.messages);
			if (nested.length > 0) {
				lines.push(...renderNestedDelegationLines(nested, theme, true, depth + 2));
			}
			const finalLine = firstNonEmptyLine(getFinalOutput(result.messages));
			if (finalLine) {
				lines.push(`${indent}    ${theme.fg("muted", "final: ")}${theme.fg("toolOutput", truncate(finalLine, 88))}`);
			}
		}
	}

	return lines;
}

function nestedDelegationText(
	messages: SingleResult["messages"],
	theme: { fg: ThemeFg },
	expanded: boolean,
): string {
	const nested = getNestedSubagentResults(messages);
	if (nested.length === 0) return "";
	const lines = renderNestedDelegationLines(nested, theme, expanded);
	if (expanded) return lines.join("\n");
	if (lines.length <= NESTED_PREVIEW_LINE_COUNT) return lines.join("\n");
	return [
		...lines.slice(0, NESTED_PREVIEW_LINE_COUNT),
		theme.fg("muted", `... ${lines.length - NESTED_PREVIEW_LINE_COUNT} more delegation lines`),
	].join("\n");
}

// ---------------------------------------------------------------------------
// renderCall — shown while the tool is being invoked
// ---------------------------------------------------------------------------

export function renderCall(args: Record<string, any>, theme: { fg: ThemeFg; bold: (s: string) => string }): Text {
	const delegationMode = normalizeDelegationMode(args.mode);
	const modeBadge = theme.fg("muted", ` [${delegationMode}]`);
	const tasks = Array.isArray(args.tasks) ? args.tasks : [];

	if (tasks.length > 1) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${tasks.length} tasks)`) +
			modeBadge;
		for (const t of tasks.slice(0, 3)) {
			text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${truncate(t.task, 40)}`)}`;
		}
		if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}

	const singleTask = tasks[0];
	const agentName = singleTask?.agent || args.agent || "...";
	const preview = singleTask?.task ? truncate(singleTask.task, 60) : args.task ? truncate(args.task, 60) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		modeBadge;
	text += `\n  ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult — shown after the tool completes
// ---------------------------------------------------------------------------

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container | Text {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) {
		const first = result.content[0];
		return new Text(first?.type === "text" && first.text ? first.text : "(no output)", 0, 0);
	}

	const delegationMode = normalizeDelegationMode(
		(details as Partial<SubagentDetails>).delegationMode,
	);
	if (details.mode === "single") {
		return renderSingleResult(details.results[0], delegationMode, expanded, theme);
	}
	return renderParallelResult(details, delegationMode, expanded, theme);
}

// ---------------------------------------------------------------------------
// Single-mode result
// ---------------------------------------------------------------------------

function renderSingleResult(
	r: SingleResult,
	delegationMode: DelegationMode,
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container | Text {
	const error = isResultError(r);
	const icon = statusIcon(r, theme);
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);
	const nestedDelegations = nestedDelegationText(r.messages, theme, expanded);

	if (expanded) {
		return renderSingleExpanded(
			r,
			delegationMode,
			icon,
			error,
			displayItems,
			finalOutput,
			nestedDelegations,
			theme,
		);
	}
	return renderSingleCollapsed(r, delegationMode, icon, error, displayItems, nestedDelegations, theme);
}

function renderSingleExpanded(
	r: SingleResult,
	delegationMode: DelegationMode,
	icon: string,
	error: boolean,
	displayItems: DisplayItem[],
	finalOutput: string,
	nestedDelegations: string,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();

	// Header
	let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}, ${delegationMode})`)}`;
	if (error && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	container.addChild(new Text(header, 0, 0));
	if (error && r.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
	}

	// Task
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
	container.addChild(new Text(theme.fg("dim", r.task), 0, 0));

	if (nestedDelegations) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Delegation tree ───"), 0, 0));
		container.addChild(new Text(nestedDelegations, 0, 0));
	}

	// Output
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
	if (displayItems.length === 0 && !finalOutput) {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	} else {
		for (const item of displayItems) {
			if (item.type === "toolCall") {
				container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
			}
		}
		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}
	}

	// Usage
	const usageStr = formatUsage(r.usage, r.model);
	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
	}

	return container;
}

function renderSingleCollapsed(
	r: SingleResult,
	delegationMode: DelegationMode,
	icon: string,
	error: boolean,
	displayItems: DisplayItem[],
	nestedDelegations: string,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource}, ${delegationMode})`)}`;
	if (error && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;

	if (error && r.errorMessage) {
		text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
	} else if (displayItems.length === 0) {
		text += `\n${theme.fg("muted", "(no output)")}`;
	} else {
		text += `\n${renderDisplayItems(displayItems, false, theme, COLLAPSED_LINE_COUNT)}`;
		if (countDisplayLines(displayItems) > COLLAPSED_LINE_COUNT) {
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
	}

	if (nestedDelegations) {
		text += `\n\n${theme.fg("muted", "Delegation tree:")}`;
		text += `\n${nestedDelegations}`;
	}

	const usageStr = formatUsage(r.usage, r.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// Parallel-mode result
// ---------------------------------------------------------------------------

function renderParallelResult(
	details: SubagentDetails,
	delegationMode: DelegationMode,
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container | Text {
	const running = details.results.filter((r) => r.exitCode === -1).length;
	const successCount = details.results.filter((r) => r.exitCode === 0).length;
	const failCount = details.results.filter((r) => r.exitCode > 0).length;
	const isRunning = running > 0;

	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");

	const status = isRunning
		? `${successCount + failCount}/${details.results.length} done, ${running} running`
		: `${successCount}/${details.results.length} tasks`;

	if (expanded && !isRunning) {
		return renderParallelExpanded(details, delegationMode, icon, status, theme);
	}
	return renderParallelCollapsed(
		details,
		delegationMode,
		icon,
		status,
		isRunning,
		expanded,
		theme,
	);
}

function renderParallelExpanded(
	details: SubagentDetails,
	delegationMode: DelegationMode,
	icon: string,
	status: string,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container {
	const mdTheme = getMarkdownTheme();
	const container = new Container();
	container.addChild(
		new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}${theme.fg("muted", ` [${delegationMode}]`)}`,
			0,
			0,
		),
	);

	for (const r of details.results) {
		const rIcon = statusIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = getFinalOutput(r.messages);
		const nestedDelegations = nestedDelegationText(r.messages, theme, true);

		container.addChild(new Spacer(1));
		container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
		container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

		if (nestedDelegations) {
			container.addChild(new Text(theme.fg("muted", "Delegation tree:"), 0, 0));
			container.addChild(new Text(nestedDelegations, 0, 0));
		}

		for (const item of displayItems) {
			if (item.type === "toolCall") {
				container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
			}
		}

		if (finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		}

		const taskUsage = formatUsage(r.usage, r.model);
		if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
	}

	const totalUsage = formatUsage(aggregateUsage(details.results));
	if (totalUsage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
	}

	return container;
}

function renderParallelCollapsed(
	details: SubagentDetails,
	delegationMode: DelegationMode,
	icon: string,
	status: string,
	isRunning: boolean,
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Text {
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}${theme.fg("muted", ` [${delegationMode}]`)}`;

	for (const r of details.results) {
		const rIcon = statusIcon(r, theme);
		const displayItems = getDisplayItems(r.messages);
		const nestedDelegations = nestedDelegationText(r.messages, theme, false);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
		if (displayItems.length === 0) {
			text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
		} else {
			text += `\n${renderDisplayItems(displayItems, false, theme, COLLAPSED_PARALLEL_LINE_COUNT)}`;
		}
		if (nestedDelegations) {
			text += `\n${theme.fg("muted", "Delegation tree:")}`;
			text += `\n${nestedDelegations}`;
		}
		const taskUsage = formatUsage(r.usage, r.model);
		if (taskUsage) text += `\n${theme.fg("dim", taskUsage)}`;
	}

	if (!isRunning) {
		const totalUsage = formatUsage(aggregateUsage(details.results));
		if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;

	return new Text(text, 0, 0);
}
