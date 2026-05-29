import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
	buildTopLevelNodes,
	countNodes,
	hasNestedChildren,
	renderTreeLines,
	setBroadcastNumberingActive,
} from "../tree.js";
import type { SingleResult, SubagentDetails, UsageStats } from "../types.js";

// Identity theme: fg returns the text unchanged so we can assert raw content.
const theme = { fg: (_color: string, text: string) => text };

const ARROW = "\u2192"; // tool_start glyph
const THINKING = "thinking\u2026"; // turn_start text
const TURN_CHECK = "\u2713"; // turn_end / tool_end glyph

function usage(partial: Partial<UsageStats> = {}): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
		...partial,
	};
}

function runningLeaf(
	agent: string,
	overrides: Partial<SingleResult> = {},
): SingleResult {
	return {
		agent,
		agentSource: "builtin",
		task: `do ${agent} work`,
		exitCode: -1, // running
		messages: [],
		stderr: "",
		usage: usage({ turns: 2 }),
		toolCalls: {},
		completedTurns: 2,
		turnInProgress: true,
		liveLog: [
			{ kind: "turn_start" },
			{ kind: "tool_start", toolName: "bash", args: { command: "grep -rn FOO src" } },
		],
		...overrides,
	};
}

function completedLeaf(agent: string, finalText: string): SingleResult {
	return {
		agent,
		agentSource: "builtin",
		task: `do ${agent} work`,
		exitCode: 0,
		messages: [
			{ role: "assistant", content: [{ type: "text", text: finalText }] } as any,
		],
		stderr: "",
		usage: usage({ turns: 4 }),
		toolCalls: {},
		completedTurns: 4,
		turnInProgress: false,
		// A completed agent keeps no live log; ensure it stays quiet even though
		// live rendering is now decoupled from showOutputPreview.
		liveLog: [],
	};
}

/** A teamlead (running) whose nested subagent batch is still in progress. */
function teamleadWithRunningChild(): SubagentDetails {
	const lead: SingleResult = {
		agent: "code-architect",
		agentSource: "builtin",
		task: "lead WS5",
		exitCode: -1, // running, blocked on its child
		messages: [
			// completed nested code-writer: assistant call + matching toolResult
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "subagent",
						toolCallId: "tc-done",
						arguments: { tasks: [{ agent: "code-writer", task: "write WS5" }] },
					},
				],
			} as any,
			{
				role: "toolResult",
				toolName: "subagent",
				toolCallId: "tc-done",
				isError: false,
				details: {
					mode: "single",
					delegationMode: "spawn",
					projectAgentsDir: null,
					results: [completedLeaf("code-writer", "All files written.")],
				},
			} as any,
			// still-running nested call: shows up as a pending child node
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "subagent",
						toolCallId: "tc-running",
						arguments: { tasks: [{ agent: "code-reviwer", task: "review WS5" }] },
					},
				],
			} as any,
		],
		stderr: "",
		usage: usage({ turns: 28 }),
		toolCalls: {},
		completedTurns: 28,
		turnInProgress: true,
		// The teamlead's own live log — this is what was previously hidden.
		liveLog: [
			{ kind: "tool_start", toolName: "subagent", args: { tasks: [{ agent: "code-reviwer" }] } },
		],
	};

	return {
		mode: "single",
		delegationMode: "spawn",
		projectAgentsDir: null,
		results: [lead],
	} as SubagentDetails;
}

describe("renderTreeLines live activity", () => {
	it("shows live activity for a nested running node even when showOutputPreview is false", () => {
		const nodes = buildTopLevelNodes(teamleadWithRunningChild());

		// Sanity: nesting exists, which in renderResult forces showOutputPreview = false.
		assert.equal(hasNestedChildren(nodes), true);

		const lines = renderTreeLines(nodes, theme, /* showOutputPreview */ false).join("\n");

		// The teamlead's own live activity (its subagent tool_start) must be visible,
		// not just a static status line.
		assert.ok(
			lines.includes(`${ARROW} subagent`),
			`expected teamlead live activity in:\n${lines}`,
		);
		// The still-running nested reviewer must appear as a child node.
		assert.ok(lines.includes("code-reviwer"), `expected nested running child in:\n${lines}`);
		// The completed code-writer is still listed.
		assert.ok(lines.includes("code-writer"), `expected completed child in:\n${lines}`);
	});

	it("renders live grandchild progress from liveNestedSubagents for a pending nested call", () => {
		const liveWriter = runningLeaf("code-writer", {
			liveLog: [
				{ kind: "tool_start", toolName: "edit", args: { path: "/repo/src/LineageNeo4jService.java" } },
			],
		});
		const lead = runningLeaf("code-architect", {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "subagent",
							toolCallId: "tc-live-writer",
							arguments: { tasks: [{ agent: "code-writer", task: "fix reviewed issues" }] },
						},
					],
				} as any,
			],
			liveNestedSubagents: {
				"tc-live-writer": {
					mode: "single",
					delegationMode: "spawn",
					projectAgentsDir: null,
					results: [liveWriter],
				} as any,
			},
		});
		const details = {
			mode: "single",
			delegationMode: "spawn",
			projectAgentsDir: null,
			results: [lead],
		} as SubagentDetails;

		const lines = renderTreeLines(buildTopLevelNodes(details), theme, false).join("\n");

		assert.ok(lines.includes("code-architect"), `expected lead in:\n${lines}`);
		assert.ok(lines.includes("code-writer"), `expected live grandchild in:\n${lines}`);
		assert.ok(lines.includes(`${ARROW} edit`), `expected live grandchild edit activity in:\n${lines}`);
		assert.ok(lines.includes("LineageNeo4jService.java"), `expected edited path preview in:\n${lines}`);
	});

	it("renders the running leaf's thinking + tool calls at any depth", () => {
		// Two-level nesting: parent (running) -> child (running leaf with liveLog).
		const child = runningLeaf("code-writer");
		const parent: SingleResult = {
			agent: "code-architect",
			agentSource: "builtin",
			task: "lead",
			exitCode: -1,
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "subagent",
							toolCallId: "tc1",
							arguments: { tasks: [{ agent: "code-writer", task: "write" }] },
						},
					],
				} as any,
				{
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "tc1",
					isError: false,
					details: {
						mode: "single",
						delegationMode: "spawn",
						projectAgentsDir: null,
						results: [child],
					},
				} as any,
			],
			stderr: "",
			usage: usage({ turns: 10 }),
			toolCalls: {},
			completedTurns: 10,
			turnInProgress: false,
			liveLog: [],
		};
		const details = {
			mode: "single",
			delegationMode: "spawn",
			projectAgentsDir: null,
			results: [parent],
		} as SubagentDetails;

		const nodes = buildTopLevelNodes(details);
		const lines = renderTreeLines(nodes, theme, false).join("\n");

		assert.ok(lines.includes(THINKING), `expected thinking line in:\n${lines}`);
		assert.ok(lines.includes(`${ARROW} bash`), `expected bash tool_start in:\n${lines}`);
		assert.ok(lines.includes("grep -rn FOO src"), `expected bash arg preview in:\n${lines}`);
	});

	it("does not emit live activity for completed (non-running) nodes", () => {
		const details = {
			mode: "single",
			delegationMode: "spawn",
			projectAgentsDir: null,
			results: [completedLeaf("code-writer", "Done.")],
		} as SubagentDetails;

		const nodes = buildTopLevelNodes(details);
		// Flat tree -> showOutputPreview would be true in renderResult.
		const lines = renderTreeLines(nodes, theme, true).join("\n");

		assert.ok(!lines.includes(THINKING), `did not expect thinking for completed node:\n${lines}`);
		assert.ok(!lines.includes(`${ARROW} `), `did not expect tool_start for completed node:\n${lines}`);
		// Completed leaf still shows its final output preview.
		assert.ok(lines.includes("Done."), `expected output preview in:\n${lines}`);
	});
});

describe("countNodes", () => {
	it("counts running and finished nodes across nesting", () => {
		const nodes = buildTopLevelNodes(teamleadWithRunningChild());
		const counts = countNodes(nodes);
		// architect (running) + code-writer (done) + code-reviwer (pending/running)
		assert.equal(counts.total, 3);
		assert.equal(counts.running, 2);
		assert.equal(counts.success, 1);
		assert.equal(counts.finished, 1);
	});
});

// Keep global numbering state clean for other test files.
setBroadcastNumberingActive(false);
