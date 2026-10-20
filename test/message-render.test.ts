import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderMessageResult, renderResult } from "../render.js";
import { buildSubagentDetails } from "../types.js";
import { makeResult } from "./helpers/results.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const receipt = { content: [{ type: "text", text: 'Message sent to subagent "Padmini".' }] };
const context = (message: string) => ({ args: { name: "Padmini", message } });

test("message previews use the same two-line prompt formatting as task previews", () => {
  const message = "Check the parser carefully.\nThen update the tests.\n" + "Keep the existing behavior. ".repeat(12);
  const task = makeResult({ agent: "", name: "Padmini", task: message });
  const launch = { content: [], details: buildSubagentDetails("single", "spawn", null, [task]) };
  for (const width of [24, 40, 80, 120]) {
    const lines = renderMessageResult(receipt, false, theme, context(message)).render(width);
    assert.deepEqual(lines, renderResult(launch, false, theme).render(width).slice(0, 2));
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes("Padmini"));
    assert.doesNotMatch(lines.join("\n"), /Message sent to subagent/);
  }
});

test("message previews fit tiny widths and Unicode without clearing toolbox backgrounds", () => {
  const colored = { ...theme, fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m` };
  for (const width of [0, 1, 2, 8, 20, 40]) {
    const lines = renderMessageResult(receipt, false, colored, context("界e\u0301".repeat(50))).render(width);
    assert.ok(lines.length <= 2);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width);
      assert.doesNotMatch(line, /\x1b\[(?:0|49)m/);
    }
  }
});

test("expanded message results show the full sent message", () => {
  const message = "First line\nSecond line\nThird line";
  const lines = renderMessageResult(receipt, true, theme, context(message)).render(80);
  assert.match(lines.join("\n"), /Third line/);
  assert.doesNotMatch(lines.join("\n"), /Message sent to subagent/);
});

test("delivery failures and historical results without arguments retain their actual result text", () => {
  const error = { content: [{ type: "text", text: "Subagent could not accept steering." }] };
  const failed = renderMessageResult(error, false, theme, { ...context("Do more work"), isError: true });
  assert.match(failed.render(80).join("\n"), /could not accept steering/);
  assert.doesNotMatch(failed.render(80).join("\n"), /Do more work/);
  assert.match(renderMessageResult(receipt, false, theme).render(80).join("\n"), /Message sent/);
});
