import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { formatSubagentLabel } from "../ui/agent-label.js";
import { renderResult } from "../render.js";
import { buildTopLevelNodes, formatLiveLogEntry, renderTreeLines } from "../tree.js";
import {
  parseTranscriptMessages,
  renderChildTreeLines,
  renderToolDetailLines,
  renderTurnOverviewLines,
  renderTurnToolListLines,
  type SubagentDetail,
} from "../detail.js";
import { SubagentPager, SubagentPicker, filterPickerItems } from "../overlay.js";
import { makeResult, makeToolCallMessage, makeToolResultMessage } from "./helpers/results.js";
import { emptyUsage, type SingleResult, type SubagentDetails } from "../types.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const detailsFor = (results: SingleResult[]): SubagentDetails => ({
  mode: "parallel",
  delegationMode: "spawn",
  projectAgentsDir: null,
  results,
  aggregatedUsage: emptyUsage(),
  aggregatedToolCalls: {},
  usageTree: [],
});
const detailFor = (identity: { name: string; agent: string; intelligence?: string }): SubagentDetail => ({
  ...identity,
  sessionDir: "",
  forkCount: 0,
  blocks: [
    { kind: "task", index: 0, prompt: "Work", events: [{ type: "tool", name: "read", preview: "", arguments: "{}" }] },
  ],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  toolCallCount: 0,
  notes: [],
});
const cases = [
  { agent: "code-writer", intelligence: "senior", label: "Margaret (Senior/code-writer)" },
  { agent: "", intelligence: "senior", label: "Margaret (Senior)" },
  { agent: "code-writer", intelligence: undefined, label: "Margaret (code-writer)" },
  { agent: "", intelligence: undefined, label: "Margaret" },
  { agent: "", intelligence: "", label: "Margaret" },
];

test("agent labels omit missing qualifiers and separators", () => {
  for (const { agent, intelligence, label } of cases) {
    assert.equal(formatSubagentLabel({ name: "Margaret", agent, intelligence }), label);
  }
  assert.equal(formatSubagentLabel({ agent: "", intelligence: "senior" }), "Senior");
  assert.equal(formatSubagentLabel({ agent: "" }), "subagent");
  assert.equal(formatSubagentLabel({ name: "Margaret" }), "Margaret");
});

test("collapsed and expanded tool results hide a blank type for running, successful, and failed agents", () => {
  for (const exitCode of [-1, 0, 1]) {
    for (const { agent, intelligence, label } of cases) {
      const details = detailsFor([makeResult({ name: "Margaret", agent, intelligence, exitCode })]);
      assert.equal(buildTopLevelNodes(details)[0].label, label);
      const result = { content: [{ type: "text", text: "Output" }], details };
      for (const expanded of [false, true]) {
        const component = renderResult(result, expanded, theme);
        const screen = component.render(120).map(stripTerminalSequences).join("\n");
        assert.ok(screen.includes(label), screen);
        if (!agent) assert.doesNotMatch(screen, /Margaret \(\)|Senior\/|unknown agent/);
        for (const width of [12, 24, 60]) {
          for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
        }
      }
    }
  }
});

test("live tool previews omit blank types without stray separators", () => {
  assert.equal(
    formatLiveLogEntry({ kind: "tool_start", toolName: "subagents", args: { tasks: [{ agent: "" }] } }, theme),
    "→ subagents",
  );
  assert.equal(
    formatLiveLogEntry(
      { kind: "tool_start", toolName: "subagents", args: { tasks: [{ agent: "" }, { agent: "writer" }, {}] } },
      theme,
    ),
    "→ subagents  writer",
  );
});

test("expanded fallback retains names and intelligence without inventing a type", () => {
  for (const { agent, intelligence, label } of cases) {
    const result = makeResult({ name: "Margaret", agent, intelligence });
    Object.defineProperty(result, "messages", {
      get() {
        throw new Error("Unreadable transcript");
      },
    });
    const screen = renderResult(
      { content: [{ type: "text", text: "Output" }], details: detailsFor([result]) },
      true,
      theme,
    )
      .render(120)
      .join("\n");
    assert.ok(screen.includes(label), screen);
    if (!agent) assert.doesNotMatch(screen, /Margaret \(\)|Senior\/|unknown agent/);
  }
});

test("pending untyped tasks remain visible and match blank-type live results", () => {
  for (const agent of ["", undefined]) {
    const childCall = makeToolCallMessage("subagents", {
      tasks: [{ name: "Margaret", agent, intelligence: "senior", task: "Work" }],
    });
    const parent = makeResult({ agent: "", name: "Olga", exitCode: -1, messages: [childCall] });
    const details = detailsFor([parent]);
    const nodes = buildTopLevelNodes(details);
    assert.equal(nodes[0].label, "Olga");
    assert.equal(nodes[0].children[0].label, "Margaret (Senior)");

    parent.liveNestedSubagents = {
      // Exercise signature matching rather than the direct tool call id path.
      otherId: detailsFor([makeResult({ agent: "", name: "Margaret", intelligence: "senior", task: "Work" })]),
    };
    assert.equal(buildTopLevelNodes(details)[0].children[0].status, "success");
    const screen = renderTreeLines(buildTopLevelNodes(details), theme, false).join("\n");
    assert.match(screen, /Margaret \(Senior\)/);
    assert.doesNotMatch(screen, /Olga \(\)|Senior\//);
  }
});

test("completed nested trees preserve blank agent types", () => {
  const children = cases.map(({ agent, intelligence }, index) =>
    makeResult({ agent, intelligence, name: `Child${index}` }),
  );
  const parent = makeResult({
    agent: "",
    name: "Olga",
    messages: [
      makeToolCallMessage("subagents", { tasks: [{ agent: "", task: "Work" }] }),
      makeToolResultMessage("subagents", detailsFor(children)),
    ],
  });
  const nodes = buildTopLevelNodes(detailsFor([parent]));
  assert.deepEqual(
    nodes[0].children.map((child) => child.label),
    cases.map(({ label }, index) => label.replace("Margaret", `Child${index}`)),
  );
});

test("picker and pager titles use the same optional type labels", () => {
  for (const { agent, intelligence, label } of cases) {
    const item = { name: "Margaret", agent, intelligence };
    const common = { theme, getRows: () => 30, requestRender() {} };
    const picker = new SubagentPicker({ ...common, items: [item], onPick() {} });
    const pager = new SubagentPager({ ...common, detail: detailFor(item), onClose() {} });
    assert.ok(picker.render(120).join("\n").includes(label));
    assert.ok(pager.render(120)[0].includes(`${label} • turn 1/1`));
    pager.handleInput("T");
    assert.ok(pager.render(120)[0].includes(`${label} • turn 1/1 • tools`));
    if (intelligence) assert.deepEqual(filterPickerItems([item], "senior"), [item]);
    for (const component of [picker, pager]) {
      for (const width of [0, 1, 12, 24, 60]) {
        for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
      }
    }
  }
});

test("transcript child metadata reaches every detail child display for launch and resume tools", () => {
  for (const toolName of ["subagents", "resume_subagents"]) {
    const results = cases.map(({ agent, intelligence }, index) =>
      makeResult({ agent, intelligence, name: `Child${index}` }),
    );
    const parsed = parseTranscriptMessages([
      { message: { role: "user", content: "Work" } },
      {
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc1", name: toolName, arguments: {} }],
        },
      },
      { message: makeToolResultMessage(toolName, detailsFor(results)) },
    ]);
    const event = parsed.blocks[0].events[0];
    assert.equal(event.type, "children");
    if (event.type !== "children") return;
    assert.equal(event.children[1].agent, "");
    assert.equal(event.children[1].intelligence, "senior");
    const detail = { ...detailFor({ name: "Olga", agent: "" }), blocks: parsed.blocks };
    const screens = [
      renderTurnOverviewLines(detail, 0, 120),
      renderTurnToolListLines(parsed.blocks[0], 0, 120),
      renderChildTreeLines(event.children, 0, 120),
      renderToolDetailLines(event, 0, 120),
    ];
    for (const lines of screens) {
      const screen = lines.join("\n");
      for (const [index, { label }] of cases.entries()) {
        assert.ok(screen.includes(label.replace("Margaret", `Child${index}`)), screen);
      }
      assert.doesNotMatch(screen, /Child\d \(\)|Child1 \(Senior\//);
    }
  }
});
