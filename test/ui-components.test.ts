import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SubagentPager, SubagentPicker, filterPickerItems } from "../overlay.js";
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
  const picker = new SubagentPicker({ ...common, items: [{ name: "测试", agent: "writer" }], onPick: () => {} });
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
