/**
 * TUI rendering for subagent tool calls and results.
 *
 * The pure tree-building and line-rendering logic lives in `tree.ts` (no
 * pi-tui dependency, unit-tested). This module only wraps those lines in
 * pi-tui Containers/Text widgets.
 */

import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import type { SubagentDetails } from "./types.js";
import {
	type ThemeFg,
	buildTopLevelNodes,
	countNodes,
	formatClockTime,
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
			`${icon} ${theme.fg("toolTitle", theme.bold("subagent tree "))}${theme.fg("dim", topLevelSummary(details, counts))}`,
			0,
			0,
		),
	);

	container.addChild(new Spacer(1));
	container.addChild(new Text(renderTreeLines(nodes, theme, showOutputPreview).join("\n"), 0, 0));

	return container;
}
