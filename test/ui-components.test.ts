import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SubagentPager, SubagentPicker, filterPickerItems } from "../overlay.js";
import { SubagentExpandView } from "../ui/expand-view.js";
import type { SubagentDetail } from "../detail.js";

const theme = {
  fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[0m`,
  bold: (text: string) => text,
};
const detail: SubagentDetail = {
  name: "测试",
  agent: "writer",
  sessionDir: "",
  forkCount: 0,
  blocks: [{ kind: "task", index: 0, prompt: "测试 task", events: [] }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  toolCallCount: 0,
  notes: [],
};

test("overlay frames respect tiny widths and wide characters", () => {
  const common = { theme, getRows: () => 24, requestRender: () => {} };
  const pager = new SubagentPager({ ...common, detail, onClose: () => {} });
  const picker = new SubagentPicker({
    ...common,
    items: [{ name: "测试", agent: "writer", intelligence: "高级 preset" }],
    onPick: () => {},
  });
  for (const component of [pager, picker]) {
    for (const width of [0, 1, 2, 3, 4, 5, 8, 20, 80]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
    }
  }
});

test("picker ranks names first without duplicate entries and accepts a selection", () => {
  const items = [
    { name: "Maria", agent: "writer", task: "review John" },
    { name: "John", agent: "reviewer" },
  ];
  assert.deepEqual(filterPickerItems(items, "John"), [items[1], items[0]]);
  let picked: string | undefined;
  const picker = new SubagentPicker({
    items,
    theme,
    getRows: () => 24,
    requestRender: () => {},
    onPick: (name) => {
      picked = name;
    },
  });
  picker.handleInput("John");
  picker.handleInput("\r");
  assert.equal(picked, "John");
});

test("picker shows and searches intelligence labels without relabeling legacy entries", () => {
  const items = [
    { name: "Maria", agent: "writer", intelligence: "myPRESET" },
    { name: "John", agent: "reviewer" },
  ];
  const picker = new SubagentPicker({
    items,
    theme,
    getRows: () => 24,
    requestRender: () => {},
    onPick: () => {},
  });
  const screen = picker.render(100).join("\n");
  assert.match(screen, /Maria \(MyPRESET\/writer\)/);
  assert.match(screen, /John \(reviewer\)/);
  assert.deepEqual(filterPickerItems(items, "mypreset"), [items[0]]);
});

test("expand view backs through nested children to the filtered list, while q closes", () => {
  const nested = (name: string, child?: string): SubagentDetail => ({
    ...detail,
    name,
    agent: "writer",
    blocks: [
      {
        kind: "task",
        index: 0,
        prompt: `${name} task`,
        events: child
          ? [
              {
                type: "children",
                toolName: "subagents",
                children: [{ name: child, agent: "writer", task: "work", status: "success" }],
              },
            ]
          : [],
      },
    ],
  });
  const details = [nested("Olga", "Maria"), nested("Maria", "Nina"), nested("Nina")];
  let closes = 0;
  const view = new SubagentExpandView({
    items: [
      { name: "Olga", agent: "writer" },
      { name: "Other", agent: "writer" },
    ],
    resolveDetail: (name) => details.find((item) => item.name === name),
    theme,
    getRows: () => 30,
    requestRender: () => {},
    onClose: () => {
      closes++;
    },
  });
  const screen = () => view.render(100).join("\n");
  view.handleInput("Olg");
  assert.match(screen(), /Expand subagent \(1\/2\)/);
  view.handleInput("\r");
  assert.match(screen(), /Olga \(writer\).*turn 1\/1/);
  view.handleInput("C");
  view.handleInput("\r"); // Maria
  view.handleInput("C");
  view.handleInput("\r"); // Nina
  assert.match(screen(), /Nina \(writer\).*turn 1\/1/);
  view.handleInput("\u001b"); // Maria
  assert.match(screen(), /Maria \(writer\).*turn 1\/1/);
  view.handleInput("\u001b"); // Olga
  assert.match(screen(), /Olga \(writer\).*turn 1\/1/);
  view.handleInput("\u001b"); // filtered picker
  assert.match(screen(), /Expand subagent \(1\/2\)/);
  assert.match(screen(), /Search:.*Olg/);
  assert.equal(closes, 0);
  view.handleInput("\r");
  view.handleInput("C");
  view.handleInput("\r"); // q closes even from Maria, without returning to Olga or the list
  view.handleInput("q");
  assert.equal(closes, 1);
});

test("direct expansion closes on root Esc and picker Esc cancels", () => {
  for (const direct of [true, false]) {
    let closes = 0;
    const view = new SubagentExpandView({
      items: [{ name: "Olga", agent: "writer" }],
      detail: direct ? { ...detail, name: "Olga" } : undefined,
      resolveDetail: () => undefined,
      theme,
      getRows: () => 30,
      requestRender: () => {},
      onClose: () => {
        closes++;
      },
    });
    view.handleInput("\u001b");
    assert.equal(closes, 1);
  }
});

test("pager invalidation rebuilds lines with the current theme", () => {
  let prefix = "old";
  const pager = new SubagentPager({
    detail,
    getRows: () => 24,
    requestRender: () => {},
    onClose: () => {},
    theme: { fg: (_color, text) => `${prefix}:${text}`, bold: (text) => text },
  });
  assert.ok(pager.render(100).some((line) => line.includes("old:TASK")));
  prefix = "new";
  pager.invalidate();
  const lines = pager.render(100);
  assert.ok(lines.some((line) => line.includes("new:TASK")));
  assert.ok(lines.every((line) => !line.includes("old:")));
});
