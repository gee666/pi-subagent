import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildSubagentDetail, parseTranscriptMessages, renderTurnOverviewLines } from "../detail.js";
import { readSessionMessages } from "../ui/session.js";
import type { SubagentNameRecord } from "../names.js";

const change = (modelId: string, provider = "openai-codex") => ({ type: "model_change", provider, modelId });
const thinking = (thinkingLevel: string) => ({ type: "thinking_level_change", thinkingLevel });
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistant = (model: string, provider = "openai-codex") => ({
  type: "message",
  message: {
    role: "assistant",
    provider,
    model,
    content: [{ type: "text", text: "Done" }],
  },
});

function fixture(entries: unknown[]) {
  fs.mkdirSync("tmp", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("tmp/detail-settings-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const record: SubagentNameRecord = {
    name: "Travis",
    agent: "code-writer",
    task: "Fix typo",
    ownerSessionId: "parent",
    sessionDir: dir,
    createdAt: 0,
    forks: {},
    model: "parent/wrong-model",
  };
  return { dir, file, record, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("expanded transcript overrides stale registry model and shows actual thinking", () => {
  const f = fixture([change("gpt-5.6-luna"), thinking("medium"), user("Fix typo"), assistant("gpt-5.6-luna")]);
  try {
    const detail = buildSubagentDetail(f.record);
    assert.equal(detail.model, "openai-codex/gpt-5.6-luna");
    assert.equal(detail.thinkingLevel, "medium");
    const output = renderTurnOverviewLines(detail, 0, 120).join("\n");
    assert.match(output, /Model: openai-codex\/gpt-5.6-luna • Thinking: medium/);
    assert.doesNotMatch(output, /wrong-model/);
    assert.equal(readSessionMessages(f.file).length, 2, "message-only readers keep their contract");
  } finally {
    f.cleanup();
  }
});

test("each resume keeps its own launch model and thinking rather than the newest values", () => {
  const f = fixture([
    change("gpt-5.6-luna"),
    thinking("medium"),
    user("Initial"),
    assistant("gpt-5.6-luna"),
    change("gpt-6-astra"),
    thinking("high"),
    user("Resume"),
    assistant("gpt-6-astra"),
    change("org/model", "other"),
    thinking("off"),
    user("Third task"),
    assistant("org/model", "other"),
  ]);
  try {
    const detail = buildSubagentDetail(f.record);
    const expected = [
      ["openai-codex/gpt-5.6-luna", "medium"],
      ["openai-codex/gpt-6-astra", "high"],
      ["other/org/model", "off"],
    ];
    detail.blocks.forEach((block, i) => {
      assert.equal(block.model, expected[i][0]);
      assert.equal(block.thinkingLevel, expected[i][1]);
      const output = renderTurnOverviewLines(detail, i, 120).join("\n");
      assert.ok(output.includes(`Model: ${expected[i][0]} • Thinking: ${expected[i][1]}`));
    });
  } finally {
    f.cleanup();
  }
});

test("legacy assistant metadata is used without guessing thinking or trusting the registry", () => {
  const f = fixture([
    user("Initial"),
    assistant("old-model", "old-provider"),
    user("Resume"),
    assistant("new-model", "new-provider"),
  ]);
  try {
    const detail = buildSubagentDetail(f.record);
    assert.equal(detail.blocks[0].model, "old-provider/old-model");
    assert.equal(detail.blocks[1].model, "new-provider/new-model");
    assert.match(renderTurnOverviewLines(detail, 0, 120).join("\n"), /Thinking: unknown/);
  } finally {
    f.cleanup();
  }
});

test("missing transcripts report unknown instead of claiming the parent model was used", () => {
  const f = fixture([]);
  try {
    fs.unlinkSync(f.file);
    const detail = buildSubagentDetail(f.record);
    assert.equal(detail.model, undefined);
    assert.match(renderTurnOverviewLines(detail, 0, 120).join("\n"), /Model: unknown • Thinking: unknown/);
  } finally {
    f.cleanup();
  }
});

test("a recorded launch is displayed even if no assistant response arrived", () => {
  const f = fixture([change("gpt-6-astra"), thinking("high")]);
  try {
    const detail = buildSubagentDetail(f.record);
    assert.match(
      renderTurnOverviewLines(detail, 0, 120).join("\n"),
      /Model: openai-codex\/gpt-6-astra • Thinking: high/,
    );
  } finally {
    f.cleanup();
  }
});

test("fork view reads settings from the selected session rather than the original record", () => {
  const original = fixture([change("gpt-5.6-luna"), thinking("medium"), user("Initial")]);
  const fork = fixture([change("gpt-6-astra"), thinking("high"), user("Fork")]);
  try {
    const detail = buildSubagentDetail(original.record, { sessionDir: fork.dir });
    assert.equal(detail.model, "openai-codex/gpt-6-astra");
    assert.equal(detail.thinkingLevel, "high");
  } finally {
    original.cleanup();
    fork.cleanup();
  }
});

test("invalid entries and synthetic model messages cannot replace real launch metadata", () => {
  const parsed = parseTranscriptMessages([
    change("gpt-5.6-luna"),
    thinking("medium"),
    user("Initial"),
    change("synthetic-tool-call"),
    assistant("synthetic-tool-call"),
    { type: "model_change", modelId: 123 },
    { type: "thinking_level_change", thinkingLevel: null },
    assistant("gpt-5.6-luna"),
  ]);
  assert.equal(parsed.blocks[0].model, "openai-codex/gpt-5.6-luna");
  assert.equal(parsed.blocks[0].thinkingLevel, "medium");
});

test("settings changed after the user message are captured before the first real response", () => {
  const parsed = parseTranscriptMessages([
    change("gpt-5.6-luna"),
    thinking("medium"),
    user("Initial"),
    assistant("gpt-5.6-luna"),
    user("Resume"),
    change("gpt-6-astra"),
    thinking("high"),
    assistant("gpt-6-astra"),
    change("another-model"),
    thinking("off"),
    assistant("another-model"),
  ]);
  assert.equal(parsed.blocks[0].model, "openai-codex/gpt-5.6-luna");
  assert.equal(parsed.blocks[0].thinkingLevel, "medium");
  assert.equal(parsed.blocks[1].model, "openai-codex/gpt-6-astra");
  assert.equal(parsed.blocks[1].thinkingLevel, "high", "later changes do not rewrite launch settings");
});
