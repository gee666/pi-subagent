import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  getActivityBlock,
  getDetailChildren,
  getTurnTools,
  parseTranscriptMessages,
  renderActivityLines,
  renderDetailLines,
  type SubagentDetail,
} from "../detail.js";
import { SubagentPager } from "../ui/pager.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const user = (content: string) => ({ message: { role: "user", content } });
const assistant = (...content: unknown[]) => ({ message: { role: "assistant", content } });
const text = (value: string) => ({ type: "text", text: value });
const tool = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: { path: `${id}.ts` } });

function detailFor(entries: unknown[]): SubagentDetail {
  const parsed = parseTranscriptMessages(entries);
  return {
    name: "Olga",
    agent: "writer",
    sessionDir: "",
    forkCount: 0,
    notes: [],
    blocks: parsed.blocks,
    usage: parsed.usage,
    toolCallCount: parsed.toolCallCount,
  };
}

const activity = () =>
  detailFor([
    { type: "model_change", provider: "provider", modelId: "first" },
    { type: "thinking_level_change", thinkingLevel: "medium" },
    user("Implement the feature"),
    assistant(text("Inspecting the code"), tool("read", "read")),
    assistant(text("First result"), text("with details")),
    { type: "model_change", provider: "provider", modelId: "second" },
    { type: "thinking_level_change", thinkingLevel: "high" },
    user("Also cover Unicode 测试"),
    assistant(tool("edit", "edit")),
    { message: { role: "toolResult", toolCallId: "edit", content: "write failed", isError: true } },
    assistant(text("Added the requested tests")),
    user("One more pending instruction"),
  ]);

function pagerFor(
  detail: SubagentDetail,
  options: { rows?: number; resolveDetail?: (name: string) => SubagentDetail | undefined } = {},
) {
  return new SubagentPager({
    detail,
    theme,
    getRows: () => options.rows ?? 70,
    resolveDetail: options.resolveDetail,
    requestRender() {},
    onClose() {},
  });
}

test("activity keeps all messages and responses in order without inventing resume boundaries", () => {
  const detail = activity();
  const original = JSON.stringify(detail);
  const lines = renderActivityLines(detail, 120);
  const screen = lines.join("\n");
  const ordered = [
    "TASK",
    "Implement the feature",
    "Inspecting the code",
    "TOOLS • read ×1",
    "First result",
    "with details",
    "MESSAGE 2",
    "Also cover Unicode 测试",
    "TOOLS • edit ×1 • errors",
    "Added the requested tests",
    "MESSAGE 3",
    "One more pending instruction",
  ];
  let previous = -1;
  for (const value of ordered) {
    const next = screen.indexOf(value, previous + 1);
    assert.ok(next > previous, `missing or out of order: ${value}`);
    previous = next;
  }
  assert.match(screen, /Agent activity • 3 messages • 2 tool calls/);
  assert.match(screen, /Model: provider\/first • Thinking: medium/);
  assert.match(screen, /Model: provider\/second • Thinking: high/);
  assert.doesNotMatch(screen, /No response recorded/, "steering does not require a separate response");
  assert.doesNotMatch(screen, /Resume #|Turn \d+ of/);
  assert.deepEqual(renderDetailLines(detail, 120), lines);
  assert.equal(JSON.stringify(detail), original, "view aggregation must not mutate saved metadata or events");
  assert.equal(getTurnTools(getActivityBlock(detail)).length, 2);
});

test("tool inspection and search span every message in the agent activity", () => {
  const pager = pagerFor(activity());
  const screen = () => pager.render(120).join("\n");
  assert.match(screen(), /First result[\s\S]*Added the requested tests/);
  pager.handleInput("\u001b[D");
  pager.handleInput("\u001b[C");
  assert.match(screen(), /First result[\s\S]*Added the requested tests/);
  pager.handleInput("T");
  assert.match(screen(), /2 tool calls in this activity[\s\S]*read read.ts[\s\S]*edit edit.ts/);
  pager.handleInput("/");
  pager.handleInput("edit.ts");
  pager.handleInput("\r");
  screen();
  pager.handleInput("\r");
  assert.match(screen(), /Tool 2: edit[\s\S]*write failed/);
  pager.handleInput("\u001b");
  pager.handleInput("\u001b");
  assert.match(screen(), /Olga \(writer\) • activity[\s\S]*First result[\s\S]*MESSAGE 3/);
});

test("a child result arriving after steering replaces its original tool call exactly once", () => {
  const detail = detailFor([
    user("Delegate the review"),
    assistant(tool("child", "subagents"), tool("read", "read")),
    user("Concentrate on errors"),
    { message: { role: "toolResult", toolCallId: "read", content: "file contents" } },
    {
      message: {
        role: "toolResult",
        toolCallId: "child",
        toolName: "subagents",
        details: {
          mode: "parallel",
          delegationMode: "spawn",
          results: [{ name: "Maria", agent: "reviewer", task: "Review", exitCode: 0 }],
        },
      },
    },
    assistant(text("Review complete")),
  ]);
  const tools = getTurnTools(getActivityBlock(detail));
  assert.equal(tools.length, 2);
  assert.equal(tools[0].type, "children");
  assert.equal(tools[1].type, "tool");
  if (tools[1].type === "tool") assert.equal(tools[1].result, "file contents");
  assert.equal(getTurnTools(detail.blocks[0]).length, 2);
  assert.equal(getTurnTools(detail.blocks[1]).length, 0);
  assert.equal(getDetailChildren(detail).length, 1);

  const child = { ...detailFor([user("Review"), assistant(text("Child response"))]), name: "Maria", agent: "reviewer" };
  const pager = pagerFor(detail, { resolveDetail: (name) => (name === "Maria" ? child : undefined) });
  pager.render(120);
  pager.handleInput("T");
  pager.render(120);
  pager.handleInput("\u001b[B");
  pager.handleInput("\r");
  assert.match(pager.render(120).join("\n"), /Maria \(reviewer\) • activity[\s\S]*Child response/);
  pager.handleInput("\u001b");
  const restored = pager.render(120).join("\n");
  assert.match(restored, /Olga \(writer\) • activity[\s\S]*Delegate the review[\s\S]*Concentrate on errors/);
});

test("activity search reaches old and new messages in a short viewport", () => {
  const pager = pagerFor(activity(), { rows: 10 });
  const screen = () => pager.render(120).join("\n");
  screen();
  for (const query of ["pending instruction", "Inspecting the code"]) {
    pager.handleInput("/");
    pager.handleInput(query);
    pager.handleInput("\r");
    assert.ok(screen().includes(query));
  }
});

test("activity handles empty histories, resizing, wide text and theme invalidation", () => {
  assert.match(renderActivityLines(detailFor([]), 80).join("\n"), /No activity recorded yet/);
  let color = "\u001b[32m";
  const pager = new SubagentPager({
    detail: activity(),
    theme: { fg: (_color, value) => `${color}${value}\u001b[0m`, bold: (value) => value },
    getRows: () => 70,
    requestRender() {},
    onClose() {},
  });
  const initial = pager.render(120).map(stripTerminalSequences);
  assert.ok(pager.render(120).some((line) => line.includes("\u001b[32m")));
  color = "\u001b[34m";
  pager.invalidate();
  const changed = pager.render(120);
  assert.deepEqual(changed.map(stripTerminalSequences), initial);
  assert.ok(changed.every((line) => !line.includes("\u001b[32m")));
  for (const width of [0, 1, 2, 3, 8, 20, 80, 120]) {
    for (const line of pager.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});
