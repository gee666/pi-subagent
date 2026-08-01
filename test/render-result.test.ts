import { strict as assert } from "node:assert";
import * as nodeModule from "node:module";
import { describe, it } from "node:test";

const registerHooks = (nodeModule as any).registerHooks as undefined | ((hooks: {
	resolve: (specifier: string, context: unknown, nextResolve: (specifier: string, context: unknown) => unknown) => unknown;
	load: (url: string, context: unknown, nextLoad: (url: string, context: unknown) => unknown) => unknown;
}) => { deregister(): void });

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("renderResult collapsed/expanded views", { skip: !registerHooks && "node:module registerHooks is unavailable" }, () => {
	it("shows compact progress when collapsed and the live six-line tree when expanded", async () => {
		const hooks = registerHooks!({
			resolve(specifier, context, nextResolve) {
				if (specifier === "@mariozechner/pi-tui") {
					return { url: "test:pi-tui", shortCircuit: true };
				}
				return nextResolve(specifier, context);
			},
			load(url, context, nextLoad) {
				if (url === "test:pi-tui") {
					return {
						format: "module",
						shortCircuit: true,
						source: `
							export class Text {
								constructor(text) { this.text = text; }
								render() { return String(this.text).split("\\n"); }
							}
							export class Spacer {
								constructor(size = 1) { this.size = size; }
								render() { return Array(this.size).fill(""); }
							}
							export class Container {
								constructor() { this.children = []; }
								addChild(child) { this.children.push(child); }
								render(width) { return this.children.flatMap((child) => child.render(width)); }
							}
						`,
					};
				}
				return nextLoad(url, context);
			},
		});

		try {
			const { renderResult } = await import("../render.js");
			const liveLog = Array.from({ length: 7 }, (_unused, index) => ({
				kind: "tool_start",
				toolName: index === 1 ? "bash" : `tool-${index}`,
				args: index === 1 ? { command: { malformed: true } } : {},
			}));
			const result = {
				content: [{ type: "text", text: "Parallel: 0/2 done, 2 running..." }],
				details: {
					mode: "parallel",
					delegationMode: "spawn",
					projectAgentsDir: null,
					results: ["code-writer", "code-reviwer"].map((agent) => ({
						agent,
						agentSource: "builtin",
						task: `run ${agent}`,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: {},
						toolCalls: {},
						completedTurns: 0,
						turnInProgress: true,
						liveLog,
					})),
				},
			};

			const collapsed = (renderResult(result, false, theme) as any).render(120).join("\n");
			const expanded = (renderResult(result, true, theme) as any).render(120).join("\n");
			const initialDetails = {
				...result.details,
				results: result.details.results.map((item) => ({ ...item, liveLog: [] })),
			};
			const expandedImmediately = (renderResult(
				{ ...result, details: initialDetails },
				true,
				theme,
			) as any).render(120).join("\n");

			assert.match(collapsed, /Parallel: 0\/2 done, 2 running/);
			assert.doesNotMatch(collapsed, /subagent tree/);
			assert.match(expanded, /subagent tree/);
			assert.match(expanded, /code-writer/);
			assert.match(expanded, /code-reviwer/);
			assert.match(expandedImmediately, /code-writer/);
			assert.match(expandedImmediately, /code-reviwer/);
			assert.match(expanded, /→ bash/);
			assert.doesNotMatch(expanded, /tool-0/);
			assert.match(expanded, /tool-6/);
			assert.equal(
				expanded.split("\n").filter((line: string) => line.trimStart().startsWith("→ ")).length,
				12,
				"expected exactly six live lines for each running subagent",
			);

			const singleCollapsed = (renderResult({
				content: [{ type: "text", text: `long streamed output\n${"hidden".repeat(100)}` }],
				details: { ...result.details, mode: "single", results: [result.details.results[0]] },
			}, false, theme) as any).render(120).join("\n");
			assert.equal(singleCollapsed, "Agent code-writer: running...");
			assert.doesNotMatch(singleCollapsed, /hidden/);

			const nestedWriter = {
				...result.details.results[0],
				agent: "nested-writer",
				liveLog,
			};
			const nestedResult = {
				content: [{ type: "text", text: "running" }],
				details: {
					...result.details,
					mode: "single",
					results: [{
						...result.details.results[0],
						agent: "team-lead",
						liveLog: [],
						messages: [
							{
								role: "assistant",
								content: [{
									type: "toolCall",
									name: "subagents",
									toolCallId: "nested-call",
									arguments: { tasks: [{ agent: "nested-writer", task: "write" }] },
								}],
							},
							{
								role: "toolResult",
								toolName: "subagents",
								toolCallId: "nested-call",
								isError: false,
								details: { ...result.details, mode: "single", results: [null, nestedWriter] },
							},
						],
					}],
				},
			};
			const nestedExpanded = (renderResult(nestedResult as any, true, theme) as any)
				.render(120)
				.join("\n");
			assert.match(nestedExpanded, /team-lead/);
			assert.match(nestedExpanded, /unknown agent/);
			assert.match(nestedExpanded, /nested-writer/);
			assert.match(nestedExpanded, /tool-6/);
		} finally {
			hooks.deregister();
		}
	});
});
