import assert from "node:assert/strict";
import test from "node:test";

import {
  findNameRecord,
  getTurnResponse,
  parseTranscriptMessages,
  renderToolDetailLines,
  renderTurnOverviewLines,
  renderTurnToolListLines,
  type SubagentDetail,
  type DetailBlock,
} from "../detail.js";
import { classifyKey, findMatch, SubagentPager } from "../overlay.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentNameRecord } from "../names.js";

test("parseTranscriptMessages separates initial task and resumes", () => {
  const messages = [
    {
      timestamp: "2026-01-01T10:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "Initial task" }] },
    },
    {
      message: {
        role: "assistant",
        usage: { input: 10, output: 4, cacheRead: 2, cost: { total: 0.01 } },
        content: [
          { type: "thinking", thinking: "Inspect first" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "/tmp/a.ts" } },
        ],
      },
    },
    {
      message: {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text: "first result\nsecond line" }],
      },
    },
    {
      timestamp: "2026-01-01T11:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "Now add tests" }] },
    },
    {
      message: {
        role: "assistant",
        usage: { input: 6, output: 3, cost: 0.02 },
        content: [{ type: "text", text: "Done." }],
      },
    },
  ];

  const parsed = parseTranscriptMessages(messages);
  assert.equal(parsed.blocks.length, 2);
  assert.equal(parsed.blocks[0].kind, "task");
  assert.equal(parsed.blocks[0].prompt, "Initial task");
  assert.equal(parsed.blocks[1].kind, "resume");
  assert.equal(parsed.blocks[1].prompt, "Now add tests");
  assert.equal(parsed.toolCallCount, 1);
  assert.deepEqual(parsed.usage, {
    input: 16,
    output: 7,
    cacheRead: 2,
    cacheWrite: 0,
    cost: 0.03,
    turns: 2,
  });
  assert.deepEqual(parsed.blocks[0].events[1], {
    type: "tool",
    name: "read",
    preview: "/tmp/a.ts",
    arguments: '{\n  "path": "/tmp/a.ts"\n}',
    isError: false,
    result: "first result\nsecond line",
  });
});

test("final response preserves every text part from the final assistant message", () => {
  const block: DetailBlock = {
    kind: "task",
    index: 0,
    prompt: "",
    events: [
      { type: "text", text: "old response", assistantTurn: 1 },
      { type: "text", text: "final part one", assistantTurn: 2 },
      { type: "text", text: "final part two", assistantTurn: 2 },
    ],
  };
  assert.equal(getTurnResponse(block), "final part one\nfinal part two");
});

test("nested subagents render as collapsed named children", () => {
  const messages = [
    { message: { role: "user", content: [{ type: "text", text: "Lead task" }] } },
    {
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "sub1",
            name: "subagents",
            arguments: { tasks: [{ agent: "writer", task: "Implement" }] },
          },
        ],
      },
    },
    {
      message: {
        role: "toolResult",
        toolCallId: "sub1",
        toolName: "subagents",
        details: {
          mode: "parallel",
          delegationMode: "spawn",
          results: [{ agent: "writer", name: "Olga", task: "Implement", exitCode: 0 }],
        },
      },
    },
  ];

  const parsed = parseTranscriptMessages(messages);
  assert.deepEqual(parsed.blocks[0].events, [
    {
      type: "children",
      toolName: "subagents",
      children: [{ name: "Olga", agent: "writer", task: "Implement", status: "success" }],
    },
  ]);
});

test("findNameRecord is case-insensitive", () => {
  const record: SubagentNameRecord = {
    name: "Olga",
    agent: "writer",
    task: "",
    ownerSessionId: "parent",
    sessionDir: "",
    createdAt: 0,
    forks: {},
  };
  assert.equal(findNameRecord({ version: 1, counters: {}, agents: { Olga: record } }, "olga"), record);
});

const detailFixture: SubagentDetail = {
  name: "Olga",
  agent: "writer",
  sessionDir: "/tmp/olga",
  forkCount: 0,
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  toolCallCount: 2,
  notes: [],
  blocks: [
    {
      kind: "task",
      index: 0,
      prompt: "Do the work",
      events: [
        { type: "tool", name: "read", preview: "a.ts", arguments: '{\n  "path": "a.ts"\n}', result: "file contents" },
        {
          type: "children",
          toolName: "subagents",
          children: [{ name: "Maria", agent: "reviewer", task: "Review", status: "success" }],
        },
        { type: "text", text: "Initial final response" },
      ],
    },
    { kind: "resume", index: 1, prompt: "Fix review", events: [{ type: "text", text: "Resume final response" }] },
  ],
};

test("turn overview shows only one task/response with compact tools and children", () => {
  const text = renderTurnOverviewLines(detailFixture, 0, 80).join("\n");
  assert.match(text, /Turn 1 of 2: Initial task/);
  assert.match(text, /TASK[\s\S]*Do the work/);
  assert.match(text, /RESPONSE[\s\S]*Initial final response/);
  assert.match(text, /2 calls: read ×1, subagents ×1/);
  assert.match(text, /Maria \(reviewer\)/);
  assert.match(text, /Press C to select and expand a child/);
  assert.doesNotMatch(text, /file contents/);
  assert.doesNotMatch(text, /\"path\"/);

  const resume = renderTurnOverviewLines(detailFixture, 1, 80).join("\n");
  assert.match(resume, /Turn 2 of 2: Resume #1/);
  assert.match(resume, /Fix review/);
  assert.match(resume, /Resume final response/);
  assert.doesNotMatch(resume, /Do the work/);
});

test("tool list is compact and tool detail contains full arguments and result", () => {
  const block = detailFixture.blocks[0];
  const list = renderTurnToolListLines(block, 0, 80).join("\n");
  assert.match(list, /read a\.ts/);
  assert.match(list, /subagents[\s\S]*Maria \(reviewer\)/);
  assert.doesNotMatch(list, /file contents/);

  const event = block.events[0];
  assert.ok(event.type === "tool");
  const detail = renderToolDetailLines(event, 0, 80).join("\n");
  assert.match(detail, /ARGUMENTS[\s\S]*\"path\": \"a\.ts\"/);
  assert.match(detail, /RESULT[\s\S]*file contents/);
});

test("pager classifies navigation keys and wraps search matches", () => {
  assert.equal(classifyKey("\u001b"), "close");
  assert.equal(classifyKey("\u001b[A"), "up");
  assert.equal(classifyKey("\u001b[6~"), "page-down");
  assert.equal(classifyKey("G"), "end");
  assert.equal(findMatch(["one", "target", "three"], "TARGET", 2, 1), 1);
  assert.equal(findMatch(["one", "target", "three"], "missing", 0, 1), -1);
});

test("pager navigates turns, tools, and named children", () => {
  const childDetail: SubagentDetail = {
    ...detailFixture,
    name: "Maria",
    agent: "reviewer",
    blocks: [{ kind: "task", index: 0, prompt: "Review", events: [{ type: "text", text: "Child response" }] }],
  };
  const pager = new SubagentPager({
    detail: detailFixture,
    resolveDetail: (name) => (name === "Maria" ? childDetail : undefined),
    getRows: () => 30,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    requestRender: () => {},
    onClose: () => {},
  });
  assert.match(pager.render(100).join("\n"), /Resume final response/);
  pager.handleInput("\u001b[D");
  assert.match(pager.render(100).join("\n"), /Initial final response/);
  pager.handleInput("T");
  assert.match(pager.render(100).join("\n"), /2 tool calls in this turn/);
  pager.handleInput("\r");
  const tool = pager.render(100).join("\n");
  assert.match(tool, /Tool 1: read/);
  assert.match(tool, /file contents/);

  // Child rows inside the tool list are selectable and enterable.
  pager.handleInput("\u001b");
  pager.handleInput("\u001b[B"); // -> subagents tool row
  pager.handleInput("\u001b[B"); // -> its Maria child row
  assert.match(pager.render(100).join("\n"), /Enter to expand/);
  pager.handleInput("\r");
  assert.match(pager.render(100).join("\n"), /Maria \(reviewer\)[\s\S]*Child response/);
  pager.handleInput("\u001b"); // back to Olga's overview
  assert.match(pager.render(100).join("\n"), /Olga \(writer\)/);
  pager.handleInput("T");
  assert.match(pager.render(100).join("\n"), /2 tool calls in this turn/);

  pager.handleInput("/");
  for (const char of "subagents") pager.handleInput(char);
  pager.handleInput("\r");
  pager.handleInput("\r");
  const searchedTool = pager.render(100).join("\n");
  assert.match(searchedTool, /Tool 2: subagents/);
  assert.match(searchedTool, /Maria \(reviewer\)/);

  pager.handleInput("\u001b"); // tool detail -> tools
  pager.handleInput("\u001b"); // tools -> overview
  pager.handleInput("C");
  assert.match(pager.render(100).join("\n"), /1 direct child[\s\S]*Maria \(reviewer\)/);
  pager.handleInput("\r");
  assert.match(pager.render(100).join("\n"), /Maria \(reviewer\)[\s\S]*Child response/);
  pager.handleInput("\u001b");
  assert.match(pager.render(100).join("\n"), /Olga \(writer\)/);
});

test("pager never renders wider than the supplied width", () => {
  const pager = new SubagentPager({
    detail: { ...detailFixture, name: "an extremely long subagent title that cannot fit" },
    getRows: () => 10,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    requestRender: () => {},
    onClose: () => {},
  });
  for (const line of pager.render(12)) assert.ok(visibleWidth(line) <= 12);
});
