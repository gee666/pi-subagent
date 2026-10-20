import assert from "node:assert/strict";
import { test } from "node:test";
import { startedResult } from "../extension/launch-result.js";
import { buildSubagentDetails } from "../types.js";
import { renderResult } from "../render.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("launch receipts display intelligence and type with the original shared label rules", () => {
  for (const [agent, intelligence, label] of [
    ["writer", "senior", "Roberto (Senior/writer)"],
    ["", "senior", "Roberto (Senior)"],
    ["writer", undefined, "Roberto (writer)"],
    ["", undefined, "Roberto"],
  ]) {
    const receipt = startedResult(
      { agent: agent!, task: "Do the work" },
      "Roberto",
      undefined,
      "/worker",
      intelligence,
    );
    const result = { content: [], details: buildSubagentDetails("single", "spawn", null, [receipt]) };
    for (const expanded of [false, true]) {
      const screen = renderResult(result, expanded, theme).render(120).join("\n");
      assert.ok(screen.includes(label!), screen);
      if (!agent && !intelligence) assert.doesNotMatch(screen, /Roberto \(/);
    }
  }
});
