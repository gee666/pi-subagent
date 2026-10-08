import assert from "node:assert/strict";
import test from "node:test";
import { Box, visibleWidth } from "@earendil-works/pi-tui";
import { renderResult } from "../render.js";
import { statusEmoji } from "../ui/tree-format.js";
import { wrapPlain } from "../ui/detail-lines.js";

const theme = {
  fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m`,
  bold: (text: string) => text,
};
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function result(exitCode: number, task: string, name = "Theodelinda") {
  return {
    content: [{ type: "text", text: "working" }],
    details: {
      mode: "single",
      delegationMode: "spawn",
      projectAgentsDir: null,
      results: [{ agent: "worker", name, task, exitCode, messages: [], stderr: "", usage: {}, liveLog: [] }],
    },
  };
}

test("status symbols have a stable single-column text presentation", () => {
  for (const status of ["running", "error", "success"] as const) {
    const symbol = plain(statusEmoji(status, theme));
    assert.equal(visibleWidth(symbol), 1);
    assert.doesNotMatch(symbol, /\p{Emoji_Presentation}/u);
  }
});

test("toolbox backgrounds keep equal widths across statuses, expansion and resize", () => {
  for (const exitCode of [-1, 0, 1]) {
    for (const expanded of [false, true]) {
      const box = new Box(1, 1, (text) => `\x1b[48;5;236m${text}\x1b[49m`);
      box.addChild(
        renderResult(result(exitCode, "Check nested shells and fix the environment. ".repeat(8)), expanded, theme),
      );
      for (const width of [12, 40, 80, 120, 40]) {
        for (const line of box.render(width)) {
          assert.equal(visibleWidth(line), width);
          if (!expanded) {
            assert.doesNotMatch(line, /\x1b\[(?:0|49)m.*\S/);
            assert.doesNotMatch(line, /\x1b\[0m/);
          }
        }
      }
    }
  }
});

test("collapsed prompts preserve wide and combining characters across the line break", () => {
  const task = "界e\u0301".repeat(14);
  const lines = renderResult(result(-1, task, "李"), false, theme)
    .render(40)
    .map(plain);
  const prefix = "  … 李 (worker) ";
  assert.ok(lines[0].startsWith(prefix));
  assert.equal(lines[1].length - lines[1].trimStart().length, visibleWidth(prefix));
  assert.equal(lines[0].slice(prefix.length) + lines[1].trimStart(), task);
  for (const width of [0, 1, 2, 8, 20, 40]) {
    for (const line of renderResult(result(-1, task, "李"), false, theme).render(width)) {
      assert.ok(visibleWidth(line) <= width);
    }
  }
});

test("detail wrapping measures columns without splitting graphemes", () => {
  const text = "界e\u0301".repeat(12);
  const lines = wrapPlain(text, 7);
  assert.equal(lines.join(""), text);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 7);
    assert.ok(!line.startsWith("\u0301"));
  }
});
