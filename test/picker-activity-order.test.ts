import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentDetail } from "../detail.js";
import { SubagentPicker, type PickerItem } from "../ui/picker.js";
import { SubagentExpandView } from "../ui/expand-view.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const initial: PickerItem[] = [
  { name: "Anna", agent: "worker", status: "running", depth: 0 },
  { name: "Olga", agent: "worker", status: "idle", depth: 1 },
  { name: "Other", agent: "writer" },
];
const detail: SubagentDetail = {
  name: "Olga",
  agent: "worker",
  sessionDir: "",
  forkCount: 0,
  blocks: [{ kind: "task", index: 0, prompt: "work", events: [] }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  toolCallCount: 0,
  notes: [],
};

test("live picker updates preserve query and selected name, and skip unchanged renders", () => {
  let renders = 0;
  let picked: string | undefined;
  const picker = new SubagentPicker({
    items: initial,
    theme,
    getRows: () => 24,
    requestRender: () => renders++,
    onPick: (name) => {
      picked = name;
    },
  });
  picker.handleInput("worker");
  picker.handleInput("\u001b[B");
  const changed: PickerItem[] = [{ ...initial[1], status: "running" }, { ...initial[0], status: "idle" }, initial[2]];
  assert.equal(picker.setItems(changed), true);
  const screen = picker.render(100).join("\n");
  assert.match(screen, /Search: worker/);
  assert.match(screen, /Expand subagent \(2\/3\)/);
  assert.match(screen, /> ● d1 Olga/);
  assert.ok(screen.indexOf("Olga") < screen.indexOf("Anna"));
  const before = renders;
  assert.equal(picker.setItems(changed.map((item) => ({ ...item }))), false);
  assert.equal(renders, before);
  picker.handleInput("\r");
  assert.equal(picked, "Olga");
});

test("picker clamps removed selections and handles an empty live result", () => {
  let picked: string | undefined;
  const picker = new SubagentPicker({
    items: initial,
    theme,
    getRows: () => 5,
    requestRender: () => {},
    onPick: (name) => {
      picked = name;
    },
  });
  picker.handleInput("worker");
  picker.handleInput("\u001b[B");
  picker.setItems([initial[0], initial[2]]);
  picker.handleInput("\r");
  assert.equal(picked, "Anna");
  picker.setItems([initial[2]]);
  assert.match(picker.render(100).join("\n"), /No matching subagent/);
  picker.setItems([initial[1]]);
  assert.match(picker.render(100).join("\n"), /Search: worker/);
  picker.handleInput("\r");
  assert.equal(picked, "Olga");
});

test("status and depth marks fit narrow frames and leave history unmarked", () => {
  const picker = new SubagentPicker({
    items: [...initial, { name: "测试", agent: "worker", status: "running", depth: 12 }],
    theme,
    getRows: () => 24,
    requestRender: () => {},
    onPick: () => {},
  });
  const screen = picker.render(100).join("\n");
  assert.match(screen, /● d0 Anna/);
  assert.match(screen, /○ d1 Olga/);
  assert.match(screen, /  Other/);
  assert.match(screen, /● d12 测试/);
  for (const width of [0, 1, 2, 4, 8, 20, 80]) {
    assert.ok(picker.render(width).every((line) => visibleWidth(line) <= width));
  }
});

test("open expand view polls within a second and preserves the picker behind detail navigation", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let items = initial;
  let reads = 0;
  let renders = 0;
  let closes = 0;
  const picked: string[] = [];
  const view = new SubagentExpandView({
    items,
    getItems: () => {
      reads++;
      return items;
    },
    resolveDetail: (name) => {
      picked.push(name);
      return detail;
    },
    theme,
    getRows: () => 24,
    requestRender: () => renders++,
    onClose: () => closes++,
  });
  t.after(() => view.dispose());
  view.handleInput("worker");
  view.handleInput("\u001b[B");
  items = [{ ...initial[1], status: "running" }, { ...initial[0], status: "idle" }, initial[2]];
  t.mock.timers.tick(999);
  assert.equal(reads, 0);
  t.mock.timers.tick(1);
  assert.equal(reads, 1);
  const before = renders;
  t.mock.timers.tick(1000);
  assert.equal(reads, 2);
  assert.equal(renders, before, "unchanged polling must not request rendering");
  view.handleInput("\r");
  assert.deepEqual(picked, ["Olga"]);
  items = [{ ...initial[0], status: "running" }, { ...initial[1], status: "idle" }, initial[2]];
  t.mock.timers.tick(1000);
  view.handleInput("\u001b");
  const screen = view.render(100).join("\n");
  assert.match(screen, /Search: worker/);
  assert.match(screen, /> ○ d1 Olga/);
  view.handleInput("\r");
  assert.deepEqual(picked, ["Olga", "Olga"]);
  view.handleInput("q");
  assert.equal(closes, 1);
  const afterClose = reads;
  t.mock.timers.tick(5000);
  assert.equal(reads, afterClose);
});

test("disposing an overlay cancels polling without calling onClose", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  let closes = 0;
  const view = new SubagentExpandView({
    items: initial,
    getItems: () => {
      reads++;
      return [];
    },
    resolveDetail: () => undefined,
    theme,
    getRows: () => 24,
    requestRender: () => {},
    onClose: () => closes++,
  });
  view.dispose();
  view.dispose();
  t.mock.timers.tick(5000);
  assert.equal(reads, 0);
  assert.equal(closes, 0);
});
