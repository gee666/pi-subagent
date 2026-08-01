/**
 * TUI rendering for subagent tool calls and results.
 *
 * The pure tree-building and line-rendering logic lives in `tree.ts` (no
 * pi-tui dependency, unit-tested). This module only wraps those lines in
 * pi-tui Containers/Text widgets.
 */

import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import {
	MAX_LIVE_LOG_ENTRIES,
	isResultError,
	isSubagentDetails,
	type SingleResult,
	type SubagentDetails,
} from "./types.js";
import {
	type ThemeFg,
	buildTopLevelNodes,
	countNodes,
	formatClockTime,
	formatLiveLogEntry,
	hasNestedChildren,
	renderTreeLines,
	setBroadcastNumberingActive,
	topLevelSummary,
	truncate,
} from "./tree.js";

export { setBroadcastNumberingActive };

// ---------------------------------------------------------------------------
// Call-start timestamps
//
// The execute() handlers record the wall-clock start per toolCallId; renderCall
// looks it up via the render context. Historical calls re-rendered after a
// session reload have no recorded start time and simply render without a
// timestamp (better than showing a wrong one).
// ---------------------------------------------------------------------------

const callStartTimes = new Map<string, number>();
const CALL_START_CACHE_LIMIT = 500;

/** Record the start time of a subagent tool call. Called from execute(). */
export function recordToolCallStart(toolCallId: string): void {
	if (callStartTimes.has(toolCallId)) return;
	callStartTimes.set(toolCallId, Date.now());
	if (callStartTimes.size > CALL_START_CACHE_LIMIT) {
		const oldest = callStartTimes.keys().next().value;
		if (oldest !== undefined) callStartTimes.delete(oldest);
	}
}

function getCallStartStamp(
	context: { toolCallId?: string } | undefined,
	theme: { fg: ThemeFg },
): string {
	const toolCallId = context?.toolCallId;
	if (!toolCallId) return "";
	const at = callStartTimes.get(toolCallId);
	if (at === undefined) return "";
	return `${theme.fg("dim", formatClockTime(at))} `;
}

// ---------------------------------------------------------------------------
// renderCall — shown while the tool is being invoked
// ---------------------------------------------------------------------------

export function renderCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: { isPartial?: boolean; isError?: boolean; toolCallId?: string },
): Text {
	const tasks = Array.isArray(args.tasks) ? args.tasks : [];
	const count = tasks.length;
	const icon = context?.isPartial === false
		? context.isError
			? theme.fg("error", "❌")
			: theme.fg("success", "✅")
		: theme.fg("warning", "⏳");
	const stamp = getCallStartStamp(context, theme);
	let text = `${stamp}${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`)}`;
	for (const task of tasks.slice(0, 6)) {
		const agent = typeof task?.agent === "string" ? task.agent : "...";
		const preview = typeof task?.task === "string" ? ` ${truncate(task.task, 56)}` : "";
		text += `\n  ${icon} ${theme.fg("accent", agent)}${theme.fg("dim", preview)}`;
	}
	if (tasks.length > 6) text += `\n  ${theme.fg("muted", `... +${tasks.length - 6} more`)}`;
	return new Text(text, 0, 0);
}

/**
 * renderCall for the resume_subagents tool: { resumes: [{ subagent, task }] }.
 * Tolerates the legacy { name, prompt } field names from older sessions.
 */
export function renderResumeCall(
	args: Record<string, any>,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: { isPartial?: boolean; isError?: boolean; toolCallId?: string },
): Text {
	const resumes = Array.isArray(args.resumes)
		? args.resumes
		: args.resumes && typeof args.resumes === "object"
			? [args.resumes]
			: [];
	const count = resumes.length;
	const icon = context?.isPartial === false
		? context.isError
			? theme.fg("error", "❌")
			: theme.fg("success", "✅")
		: theme.fg("warning", "⏳");
	const stamp = getCallStartStamp(context, theme);
	let text = `${stamp}${theme.fg("toolTitle", theme.bold("resume subagents "))}${theme.fg("accent", `${count} subagent${count === 1 ? "" : "s"}`)}`;
	for (const resume of resumes.slice(0, 6)) {
		const name = typeof resume?.subagent === "string"
			? resume.subagent
			: typeof resume?.name === "string"
				? resume.name
				: "...";
		const task = typeof resume?.task === "string" ? resume.task : typeof resume?.prompt === "string" ? resume.prompt : undefined;
		const preview = task !== undefined ? ` ${truncate(task, 56)}` : "";
		text += `\n  ${icon} ${theme.fg("accent", name)}${theme.fg("dim", preview)}`;
	}
	if (resumes.length > 6) text += `\n  ${theme.fg("muted", `... +${resumes.length - 6} more`)}`;
	return new Text(text, 0, 0);
}

// ---------------------------------------------------------------------------
// renderResult — shown after the tool completes / streams updates
// ---------------------------------------------------------------------------

function getResultText(
	result: { content?: Array<{ type: string; text?: string }> },
): string {
	const first = Array.isArray(result.content) ? result.content[0] : undefined;
	return first?.type === "text" && typeof first.text === "string" && first.text
		? first.text
		: "(no output)";
}

function compactText(text: string, maxLength = 240): string {
	const firstLine = text.replace(/\r\n?/g, "\n").split("\n").find((line) => line.trim()) ?? "(no output)";
	return truncate(firstLine, maxLength);
}

function isRenderableResult(value: unknown): value is SingleResult {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof (value as Partial<SingleResult>).agent === "string" &&
		typeof (value as Partial<SingleResult>).exitCode === "number";
}

function getCollapsedResultText(details: SubagentDetails, fallbackText: string): string {
	const results = details.results.filter(isRenderableResult);
	if (results.length === 0) return compactText(fallbackText);

	const running = results.filter((item) => item.exitCode === -1).length;
	const finished = results.length - running;
	const succeeded = results.filter((item) => item.exitCode === 0 && !isResultError(item)).length;
	const failed = finished - succeeded;

	if (details.mode === "parallel") {
		return running > 0
			? `Parallel: ${finished}/${results.length} done, ${running} running...`
			: `Parallel: ${succeeded}/${results.length} succeeded${failed > 0 ? `, ${failed} failed` : ""}`;
	}

	const item = results[0];
	if (item.exitCode === -1) return `Agent ${item.agent}: running...`;
	if (isResultError(item)) {
		const reason = [item.errorMessage, item.stderr, item.stopReason]
			.find((value): value is string => typeof value === "string" && value.length > 0);
		return `Agent ${item.agent}: failed${reason ? ` — ${compactText(reason, 180)}` : ""}`;
	}
	return `Agent ${item.agent}: completed`;
}

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
): Container | Text {
	const fallbackText = getResultText(result);

	// Keep the normal row compact. Ctrl+O switches to the live tree below.
	if (!expanded) {
		const text = isSubagentDetails(result.details)
			? getCollapsedResultText(result.details, fallbackText)
			: compactText(fallbackText);
		return new Text(text, 0, 0);
	}

	if (!isSubagentDetails(result.details) || result.details.results.length === 0) {
		return new Text(fallbackText, 0, 0);
	}
	const details: SubagentDetails = result.details;

	try {
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
				`${icon} ${theme.fg("toolTitle", theme.bold("subagent tree "))}${theme.fg("dim", topLevelSummary(details, counts))}`,
				0,
				0,
			),
		);

		container.addChild(new Spacer(1));
		container.addChild(new Text(renderTreeLines(nodes, theme, showOutputPreview).join("\n"), 0, 0));
		return container;
	} catch {
		// Pi falls back to raw result.content when a custom renderer throws, which
		// made Ctrl+O appear broken until the offending rolling log entry expired.
		// Keep an expanded tree visible even for malformed third-party/RPC data.
		const lines: string[] = [];
		for (const item of details.results) {
			const agent = typeof item?.agent === "string" ? item.agent : "unknown agent";
			const icon = item?.exitCode === -1
				? theme.fg("warning", "⏳")
				: item?.exitCode === 0
					? theme.fg("success", "✅")
					: theme.fg("error", "❌");
			lines.push(`${icon} ${theme.fg("accent", agent)}`);
			const liveLog = Array.isArray(item?.liveLog)
				? item.liveLog.slice(-MAX_LIVE_LOG_ENTRIES)
				: [];
			for (const entry of liveLog) {
				lines.push(`  ${formatLiveLogEntry(entry, theme)}`);
			}
		}
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent tree"))}\n${lines.join("\n") || fallbackText}`,
			0,
			0,
		);
	}
}
