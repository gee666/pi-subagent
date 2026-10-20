import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderMessageResult, renderResult } from "../render.js";
import { buildSubagentDetails } from "../types.js";
import { makeResult } from "./helpers/results.js";
import { fixture } from "./helpers/message-subagent.js";
import { hostDouble } from "./helpers/extension.js";
import { updateNamesRegistry } from "../names.js";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const receipt = { content: [{ type: "text", text: 'Message sent to subagent "Padmini".' }] };
const context = (message: string) => ({ args: { name: "Padmini", message } });

test("message call headers and previews retain original intelligence and optional type", async () => {
  const f = await fixture();
  try {
    f.running(() => true);
    const cases = [
      { agent: "writer", intelligence: "senior", qualifier: " (Senior/writer)" },
      { agent: "", intelligence: "senior", qualifier: " (Senior)" },
      { agent: "writer", intelligence: undefined, qualifier: " (writer)" },
      { agent: "", intelligence: undefined, qualifier: "" },
    ];
    const tuiTheme = hostDouble<Theme>(theme);
    for (const { agent, intelligence, qualifier } of cases) {
      await updateNamesRegistry(f.state.currentNamesFile, (registry) => {
        Object.assign(registry.agents[f.name], { agent, intelligence });
      });
      const args = { name: f.name, message: "Continue the work." };
      const result = await f.execute(args);
      const ctx = hostDouble<RenderContext>({ args, state: {}, isError: false });
      const header = f.tool.renderCall!(args, tuiTheme, ctx).render(120).join("\n");
      assert.ok(header.includes(`${f.name}${qualifier}`), header);
      for (const expanded of [false, true]) {
        const body = f.tool.renderResult!(result, { expanded, isPartial: false }, tuiTheme, ctx).render(120).join("\n");
        assert.ok(body.includes(`${f.name}${qualifier}`), body);
        if (!qualifier) assert.doesNotMatch(body, /\(\)|Senior|writer/);
      }
    }
  } finally {
    await f.close();
  }
});

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
