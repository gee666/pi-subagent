import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as nodeModule from "node:module";
import * as path from "node:path";
import { describe, it } from "node:test";

const registerHooks = nodeModule.registerHooks;

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe(
  "renderResult collapsed/expanded views",
  { skip: !registerHooks && "node:module registerHooks is unavailable" },
  () => {
    it("shows compact progress when collapsed and the live six-line tree when expanded", async () => {
      assert.ok(registerHooks);
      const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "@earendil-works/pi-tui") {
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
							export function truncateToWidth(text, width) {
								return [...text].slice(0, width).join("");
							}
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
            results: ["code-writer", "code-reviwer"].map((agent, index) => ({
              agent,
              name: index === 0 ? "John" : "Maria",
              agentSource: "builtin",
              task: `run ${agent}`,
              startedAt: Date.now(),
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

        const collapsed = renderResult(result, false, theme).render(120).join("\n");
        const expanded = renderResult(result, true, theme).render(120).join("\n");
        const initialDetails = {
          ...result.details,
          results: result.details.results.map((item) => ({ ...item, liveLog: [] })),
        };
        const expandedImmediately = renderResult({ ...result, details: initialDetails }, true, theme)
          .render(120)
          .join("\n");

        assert.match(collapsed, /John \(code-writer\)/);
        assert.match(collapsed, /Maria \(code-reviwer\)/);
        assert.match(collapsed, /2 running • 0\/2 finished/);
        assert.match(collapsed, /last action:/);
        assert.doesNotMatch(collapsed, /subagent tree/);
        assert.match(expanded, /subagent tree/);
        assert.match(expanded, /code-writer/);
        assert.match(expanded, /code-reviwer/);
        assert.match(expanded, /prompt: run code-writer/);
        assert.match(expanded, /prompt: run code-reviwer/);
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

        const singleCollapsed = renderResult(
          {
            content: [{ type: "text", text: `long streamed output\n${"hidden".repeat(100)}` }],
            details: { ...result.details, mode: "single", results: [result.details.results[0]] },
          },
          false,
          theme,
        )
          .render(120)
          .join("\n");
        assert.match(singleCollapsed, /John \(code-writer\)/);
        assert.match(singleCollapsed, /1 running • 0\/1 finished/);
        assert.doesNotMatch(singleCollapsed, /hidden/);

        const mixedDetails = {
          ...result.details,
          results: [{ ...result.details.results[0], exitCode: 0, turnInProgress: false }, result.details.results[1]],
        };
        const mixedCollapsed = renderResult({ ...result, details: mixedDetails }, false, theme)
          .render(120)
          .join("\n");
        assert.match(mixedCollapsed, /✅ John \(code-writer\)/);
        assert.match(mixedCollapsed, /⏳ Maria \(code-reviwer\)/);

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
            results: [
              {
                ...result.details.results[0],
                agent: "team-lead",
                liveLog: [],
                messages: [
                  {
                    role: "assistant",
                    content: [
                      {
                        type: "toolCall",
                        name: "subagents",
                        toolCallId: "nested-call",
                        arguments: { tasks: [{ agent: "nested-writer", task: "write" }] },
                      },
                    ],
                  },
                  {
                    role: "toolResult",
                    toolName: "subagents",
                    toolCallId: "nested-call",
                    isError: false,
                    details: { ...result.details, mode: "single", results: [null, nestedWriter] },
                  },
                ],
              },
            ],
          },
        };
        const nestedExpanded = renderResult(nestedResult, true, theme).render(120).join("\n");
        assert.match(nestedExpanded, /team-lead/);
        assert.match(nestedExpanded, /unknown agent/);
        assert.match(nestedExpanded, /nested-writer/);
        assert.match(nestedExpanded, /tool-6/);

        // Neither collapsed nor Ctrl+O-expanded rows may read child transcripts.
        // Full transcript hydration is reserved for /subagent-expand <name>.
        const tmpDir = path.join(process.cwd(), "tmp");
        fs.mkdirSync(tmpDir, { recursive: true });
        const sessionDir = fs.mkdtempSync(path.join(tmpDir, "pi-subagent-render-lazy-"));
        try {
          fs.writeFileSync(
            path.join(sessionDir, "session.jsonl"),
            [
              JSON.stringify({ type: "session", id: "child" }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "toolCall",
                      name: "subagents",
                      toolCallId: "nested",
                      arguments: { tasks: [{ agent: "nested-agent", task: "nested work" }] },
                    },
                  ],
                },
              }),
              JSON.stringify({
                type: "message",
                message: {
                  role: "toolResult",
                  toolName: "subagents",
                  toolCallId: "nested",
                  details: {
                    ...result.details,
                    results: [{ ...result.details.results[0], agent: "nested-agent", exitCode: 0, liveLog: [] }],
                  },
                },
              }),
            ].join("\n"),
          );
          const historical = {
            content: [{ type: "text", text: "done" }],
            details: {
              ...result.details,
              results: [{ ...result.details.results[0], exitCode: 0, messages: [], liveLog: [], sessionDir }],
            },
          };
          const renderContext = { state: {} };
          const historicalCollapsed = renderResult(historical, false, theme, renderContext).render(120).join("\n");
          const historicalExpanded = renderResult(historical, true, theme, renderContext).render(120).join("\n");
          assert.doesNotMatch(historicalCollapsed, /nested-agent/);
          assert.doesNotMatch(historicalExpanded, /nested-agent/);

          // Repaint remains independent of the child transcript file.
          fs.rmSync(path.join(sessionDir, "session.jsonl"));
          const repainted = renderResult(historical, true, theme, renderContext).render(120).join("\n");
          assert.doesNotMatch(repainted, /nested-agent/);
        } finally {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      } finally {
        hooks.deregister();
      }
    });
  },
);
