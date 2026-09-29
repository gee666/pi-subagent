import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createExtensionHarness, customEntry } from "./helpers/extension.js";
import { createBudget, SUBAGENT_BUDGET_CUSTOM_TYPE } from "../budget.js";
import { SUBAGENT_INTELLIGENCE_CUSTOM_TYPE, displayIntelligence } from "../intelligence.js";
import { buildSubagentDetails, type SubagentDetails } from "../types.js";
import type { ThemeFg } from "../tree.js";
import { makeResult } from "./helpers/results.js";
import { parseTranscriptMessages, renderTurnOverviewLines } from "../detail.js";
import { renderResult } from "../render.js";

test("leaf workers persist per-run preset metadata, including explicit omission on resume", async () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/intelligence-persistence-"));
  const variables = {
    HOME: root,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_SUBAGENT_DEPTH: "1",
    PI_SUBAGENT_BUDGET_DIR: "",
    PI_SUBAGENT_DISABLE_RESUME: "true",
    PI_SUBAGENT_RUN_INTELLIGENCE: JSON.stringify("junior"),
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    const budget = createBudget(path.join(root, "budget"), 0);
    const entries = [customEntry(SUBAGENT_BUDGET_CUSTOM_TYPE, budget)];
    const host = createExtensionHarness();
    const ctx = host.makeCtx(entries, { cwd: root, hasUI: false });
    for (const intelligence of ["junior", "sENior", null]) {
      process.env.PI_SUBAGENT_RUN_INTELLIGENCE = JSON.stringify(intelligence);
      await host.emit("session_start", { reason: "startup" }, ctx);
      const recorded = entries.filter(
        (entry) => entry.type === "custom" && entry.customType === SUBAGENT_INTELLIGENCE_CUSTOM_TYPE,
      );
      assert.deepEqual(recorded.at(-1)?.data, { intelligence });
      assert.deepEqual(host.getActiveTools(), ["read", "bash"]);
    }
    const persisted: Array<{ customType?: string; data?: { intelligence?: string | null } }> = JSON.parse(
      JSON.stringify(entries),
    );
    assert.deepEqual(
      persisted
        .filter((entry) => entry.customType === SUBAGENT_INTELLIGENCE_CUSTOM_TYPE)
        .map((entry) => entry.data?.intelligence),
      ["junior", "sENior", null],
    );
    await host.emit("session_shutdown", {}, ctx);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("durable result labels survive JSON, render in both tool views, and never leak to an unselected run", () => {
  const selected = makeResult({ name: "Nicolas", agent: "code-writer", intelligence: "junior" });
  const details: SubagentDetails = JSON.parse(
    JSON.stringify(buildSubagentDetails("single", "spawn", null, [selected])),
  );
  assert.equal(details.results[0].intelligence, "junior");
  const theme = { fg: ((_color, text) => text) as ThemeFg, bold: (text: string) => text };
  for (const expanded of [false, true]) {
    const output = renderResult({ content: [], details }, expanded, theme).render(140).join("\n");
    assert.match(output, /Nicolas \(Junior\/code-writer\)/);
    const unselected = buildSubagentDetails("single", "spawn", null, [
      makeResult({ name: "Nicolas", agent: "code-writer" }),
    ]);
    const plain = renderResult({ content: [], details: unselected }, expanded, theme).render(140).join("\n");
    assert.match(plain, /Nicolas \(code-writer\)/);
    assert.doesNotMatch(plain, /Junior/);
  }
  assert.equal(displayIntelligence("sENior"), "SENior");
});

test("expanded tasks keep their own labels and truthful unknown settings across resumes", () => {
  const marker = (intelligence: string | null) => ({
    type: "custom",
    customType: SUBAGENT_INTELLIGENCE_CUSTOM_TYPE,
    data: { intelligence },
  });
  const user = (content: string) => ({ type: "message", message: { role: "user", content } });
  const entries = [
    marker("junior"),
    user("Initial"),
    marker("sENior"),
    user("Resume"),
    marker(null),
    user("Defaults"),
    user("Historical unrecorded"),
  ];
  const parsed = parseTranscriptMessages(JSON.parse(JSON.stringify(entries)));
  assert.deepEqual(
    parsed.blocks.map((block) => block.intelligence),
    ["junior", "sENior", undefined, undefined],
  );
  const detail = { name: "Nicolas", agent: "code-writer", sessionDir: "", forkCount: 0, notes: [], ...parsed };
  for (const [index, label] of ["Junior", "SENior", undefined, undefined].entries()) {
    const output = renderTurnOverviewLines(detail, index, 140).join("\n");
    assert.match(output, /Model: unknown • Thinking: unknown/);
    if (label) assert.ok(output.includes(`Intelligence: ${label}`));
    else assert.doesNotMatch(output, /Intelligence:/);
  }
});
