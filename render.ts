/**
 * TUI rendering for subagent tool calls and results.
 *
 * The pure tree-building and line-rendering logic lives in `tree.ts` (no
 * pi-tui dependency, unit-tested). This module only wraps those lines in
 * pi-tui Containers/Text widgets.
 */

import { Container, Spacer, Text } from "@mariozechner/pi-tui";

interface Component {
	render(width: number): string[];
	invalidate(): void;
}

function fitLine(text: string, width: number): string {
	if (width <= 0) return "";
	let visible = 0;
	let output = "";
	for (let i = 0; i < text.length && visible < width;) {
		if (text[i] === "\u001b") {
			const match = text.slice(i).match(/^\u001b(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/);
			if (match) {
				output += match[0];
				i += match[0].length;
				continue;
			}
		}
		const codePoint = text.codePointAt(i)!;
		const char = String.fromCodePoint(codePoint);
		output += char;
		i += char.length;
		visible += 1;
	}
	return output;
}
import {
	MAX_LIVE_LOG_ENTRIES,
	isSubagentDetails,
	type SubagentDetails,
} from "./types.js";
import {
	type ThemeFg,
	type TreeNode,
	buildTopLevelNodes,
	countNodes,
	formatClockTime,
	formatLiveLogEntry,
	hasNestedChildren,
	statusEmoji,
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

// ---------------------------------------------------------------------------
// Newest-call tracking
//
// Ctrl+O expands every subagent row at once. Rendering full detail for all of
// them is both noisy and slow, so only the most recent subagent tool call gets
// the verbose treatment (full prompts + output previews). Rows are rendered in
// chronological order, so "the highest sequence number seen so far" is a cheap
// and stable way to identify the newest call, both for live calls and for rows
// restored from a session file.
// ---------------------------------------------------------------------------

const callSequence = new Map<string, number>();
let nextCallSequence = 0;
let newestCallId: string | undefined;

function registerCall(toolCallId: string | undefined): void {
	if (!toolCallId) return;
	let seq = callSequence.get(toolCallId);
	if (seq === undefined) {
		seq = nextCallSequence++;
		callSequence.set(toolCallId, seq);
		if (callSequence.size > CALL_START_CACHE_LIMIT) {
			const oldest = callSequence.keys().next().value;
			if (oldest !== undefined && oldest !== newestCallId) callSequence.delete(oldest);
		}
	}
	const newestSeq = newestCallId === undefined ? -1 : callSequence.get(newestCallId) ?? -1;
	if (seq >= newestSeq) newestCallId = toolCallId;
}

/** Prime chronological call order from the already-loaded parent session. */
export function setHistoricalCallOrder(toolCallIds: string[]): void {
	callSequence.clear();
	nextCallSequence = 0;
	newestCallId = undefined;
	for (const toolCallId of toolCallIds) registerCall(toolCallId);
}

/** True for the most recent subagent tool call this process has rendered. */
export function isNewestCall(toolCallId: string | undefined): boolean {
	if (!toolCallId) return false;
	return newestCallId === toolCallId;
}

/** Record the start time of a subagent tool call. Called from execute(). */
export function recordToolCallStart(toolCallId: string): void {
	registerCall(toolCallId);
	if (callStartTimes.has(toolCallId)) return;
	callStartTimes.set(toolCallId, Date.now());
	if (callStartTimes.size > CALL_START_CACHE_LIMIT) {
		const oldest = callStartTimes.keys().next().value;
		if (oldest !== undefined) callStartTimes.delete(oldest);
	}
}

export function clearRenderCaches(): void {
	callStartTimes.clear();
	callSequence.clear();
	nextCallSequence = 0;
	newestCallId = undefined;
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
	registerCall(context?.toolCallId);
	const tasks = Array.isArray(args.tasks) ? args.tasks : [];
	const count = tasks.length;
	const stamp = getCallStartStamp(context, theme);
	const text = `${stamp}${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`)}`;
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
	registerCall(context?.toolCallId);
	const count = resumes.length;
	const stamp = getCallStartStamp(context, theme);
	const text = `${stamp}${theme.fg("toolTitle", theme.bold("resume subagents "))}${theme.fg("accent", `${count} subagent${count === 1 ? "" : "s"}`)}`;
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

function takePromptLine(text: string, width: number): { line: string; rest: string } {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized || width <= 0) return { line: "", rest: normalized };
	if (normalized.length <= width) return { line: normalized, rest: "" };
	let split = normalized.lastIndexOf(" ", width);
	if (split < Math.max(1, Math.floor(width / 2))) split = width;
	return { line: normalized.slice(0, split), rest: normalized.slice(split).trimStart() };
}

class CollapsedSubagentComponent implements Component {
	constructor(
		private readonly details: SubagentDetails,
		private readonly theme: { fg: ThemeFg; bold: (s: string) => string },
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		// Collapsed rows intentionally use durable result metadata only. Reading
		// child session transcripts here made every TUI repaint scale with the
		// total number of historical subagents.
		const nodes = buildTopLevelNodes(this.details, { hydrateSessions: false });
		const lines: string[] = [];
		for (const node of nodes) {
			const rawPrefix = `  ${node.status === "running" ? "⏳" : node.status === "error" ? "❌" : "✅"} ${node.label} `;
			const firstWidth = Math.max(8, width - rawPrefix.length);
			const first = takePromptLine(node.task ?? "", firstWidth);
			const continuationIndent = " ".repeat(Math.min(rawPrefix.length, Math.max(2, width - 8)));
			const second = takePromptLine(first.rest, Math.max(8, width - continuationIndent.length));
			const firstLine = `  ${statusEmoji(node.status, this.theme)} ${this.theme.fg("accent", node.label)}${first.line ? ` ${this.theme.fg("dim", first.line)}` : ""}`;
			lines.push(fitLine(firstLine, width));
			if (first.rest) {
				const hasMore = second.rest.length > 0;
				const secondText = `${second.line}${hasMore ? "..." : ""}`;
				lines.push(fitLine(`${continuationIndent}${this.theme.fg("dim", secondText)}`, width));
			}
			const actionAt = node.lastActionAt ?? node.startedAt;
			if (actionAt !== undefined) {
				lines.push(fitLine(`     ${this.theme.fg("muted", `last action: ${formatClockTime(actionAt)}`)}`, width));
			}
		}
		const counts = countNodes(nodes);
		if (lines.length > 0) lines.push("");
		lines.push(fitLine(this.theme.fg("dim", topLevelSummary(this.details, counts, { directOnly: true })), width));
		return lines;
	}

	invalidate(): void {}
}

type ResultRenderContext = {
	state?: Record<string, unknown>;
	toolCallId?: string;
};

function expandedNodes(details: SubagentDetails): TreeNode[] {
	// Never read child session transcripts here. Ctrl+O expands every historical
	// subagent row in one synchronous repaint; hydrating sessions made that cost
	// scale with every byte every subagent ever produced. Durable result metadata
	// is enough for an instant tree; `/subagent-expand <name>` shows the full
	// transcript of a single agent on demand.
	return buildTopLevelNodes(details, { hydrateSessions: false });
}

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	expanded: boolean,
	theme: { fg: ThemeFg; bold: (s: string) => string },
	context?: ResultRenderContext,
): Component | Container | Text {
	registerCall(context?.toolCallId);
	const fallbackText = getResultText(result);

	// The collapsed view remains live and shows each direct child separately.
	// Its status icon comes from that child's result, not the outer tool state,
	// so completed siblings update while other tasks are still running.
	if (!expanded) {
		return isSubagentDetails(result.details) && result.details.results.length > 0
			? new CollapsedSubagentComponent(result.details, theme)
			: new Text(compactText(fallbackText), 0, 0);
	}

	if (!isSubagentDetails(result.details) || result.details.results.length === 0) {
		return new Text(fallbackText, 0, 0);
	}
	const details: SubagentDetails = result.details;

	// Only the newest subagent call gets the verbose view (full prompts + output
	// previews). Older rows render as a compact tree, which keeps Ctrl+O both
	// instant and readable.
	const verbose = !context?.toolCallId || isNewestCall(context.toolCallId);

	try {
		const nodes = expandedNodes(details);
		const counts = countNodes(nodes);
		const showOutputPreview = verbose && !hasNestedChildren(nodes);
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
		container.addChild(new Text(renderTreeLines(nodes, theme, showOutputPreview, 0, "", verbose).join("\n"), 0, 0));
		if (!verbose) {
			container.addChild(
				new Text(theme.fg("muted", "  /subagent-expand <name> for the full work of one subagent"), 0, 0),
			);
		}
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
