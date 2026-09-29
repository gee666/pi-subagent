import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { allocateSubagentNames, readNamesRegistry } from "../names.js";
import { originalModelSettings, readOriginalSessionSettings } from "../storage/session-settings.js";
import { SUBAGENT_INTELLIGENCE_CUSTOM_TYPE, parseIntelligencePresets } from "../intelligence.js";
import { runAgentSubprocess, executeParallelSubprocess, type RunAgentOptions } from "../runner.js";
import { buildLiveSubagentDetails, buildSubagentDetails, getFinalOutput, type SingleResult } from "../types.js";

const agent = {
  name: "worker",
  description: "worker",
  source: "user" as const,
  filePath: "/fake",
  systemPrompt: "",
  model: "changed/agent",
  thinking: "low",
};
const presets = parseIntelligencePresets([
  { renamed: { model: "changed", provider: "new", "reasoning-level": "off" } },
]);
const saved = { model: "original/org/model", thinking: "high", intelligence: "removed-preset" };
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const script = `process.stdin.once("data", () => {
  const text = JSON.stringify({ args: process.argv.slice(1), label: JSON.parse(process.env.PI_SUBAGENT_RUN_INTELLIGENCE) });
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } }));
  console.log(JSON.stringify({ type: "agent_settled" }));
});`;
const options: RunAgentOptions = {
  cwd: process.cwd(),
  agents: [agent],
  agentName: "worker",
  task: "continue",
  parentDepth: 0,
  parentAgentStack: [],
  maxDepth: 1,
  preventCycles: true,
  fallbackModel: "changed/parent",
  intelligencePresets: presets,
  resumeSession: true,
  sessionDir: process.cwd(),
  resumeSettings: saved,
  makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
  piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
  startupTimeoutMsOverride: 5000,
};

test("named runner bypasses automatic/disabled presets and preserves pending and durable labels", async () => {
  const previous = process.env.PI_SUBAGENT_INTELLIGENCE;
  try {
    for (const enabled of ["true", "false"]) {
      process.env.PI_SUBAGENT_INTELLIGENCE = enabled;
      const result = await runAgentSubprocess(options);
      assert.equal(result.exitCode, 0, result.errorMessage);
      const { args, label } = JSON.parse(getFinalOutput(result.messages));
      assert.equal(flag(args, "--provider"), "original");
      assert.equal(flag(args, "--model"), "org/model");
      assert.equal(flag(args, "--thinking"), "high");
      assert.ok(args.includes("--continue"));
      assert.equal(label, "removed-preset");
      const persisted = JSON.parse(JSON.stringify(options.makeDetails([result])));
      assert.equal(persisted.results[0].intelligence, "removed-preset");
      assert.equal(persisted.results[0].thinking, "high");
      const unselected = await runAgentSubprocess({
        ...options,
        resumeSettings: { ...saved, intelligence: undefined },
      });
      assert.equal(unselected.intelligence, undefined);
      assert.equal(JSON.parse(getFinalOutput(unselected.messages)).label, null);
    }
    const controller = new AbortController();
    controller.abort();
    const updates: SingleResult[][] = [];
    await executeParallelSubprocess(
      [{ agent: "worker", task: "continue" }],
      [agent],
      process.cwd(),
      0,
      1,
      [],
      true,
      controller.signal,
      (partial) => updates.push(partial.details.results),
      (results) => buildLiveSubagentDetails("parallel", "spawn", null, results),
      undefined,
      () => process.cwd(),
      true,
      undefined,
      "changed/parent",
      undefined,
      undefined,
      { intelligencePresets: presets, resumeSettings: [saved] },
    );
    assert.equal(updates[0][0].intelligence, "removed-preset");
    assert.equal(updates.at(-1)![0].intelligence, "removed-preset", "aborted resumes keep their label too");
    assert.equal(updates.at(-1)![0].model, saved.model);
    assert.equal(updates.at(-1)![0].thinking, saved.thinking);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_INTELLIGENCE;
    else process.env.PI_SUBAGENT_INTELLIGENCE = previous;
  }
});

test("named resumes retain same-provider CLI auth but strip conflicting or unknown-provider auth", () => {
  for (const cli of [
    ["--provider", "parent", "--api-key", "parent-secret", "--thinking", "low"],
    ["--provider=parent", "--api-key=parent-secret", "--thinking=low"],
  ]) {
    const code = `
      process.argv = ["node", "pi", ...${JSON.stringify(cli)}];
      const { buildPiArgs } = await import("./runner/arguments.ts");
      const build = (saved) => buildPiArgs(${JSON.stringify(agent)}, null, "continue", ".", true,
        "changed/parent", true, undefined, undefined, saved).args;
      const launch = buildPiArgs(${JSON.stringify(agent)}, null, "launch", ".", false, "parent/old-model").args;
      const matching = build({ model: "parent/old-model", thinking: "off" });
      console.log(JSON.stringify([build(${JSON.stringify(saved)}), build({}), launch, matching]));`;
    const [pinned, legacy, launch, matching] = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], {
        cwd: process.cwd(),
        timeout: 10000,
        encoding: "utf8",
      }),
    );
    for (const args of [launch, matching]) {
      assert.equal(flag(args, "--provider"), "parent");
      assert.equal(flag(args, "--api-key"), "parent-secret");
      assert.equal(args.filter((arg: string) => arg === "--provider").length, 1);
      assert.equal(args.filter((arg: string) => arg === "--api-key").length, 1);
    }
    assert.equal(flag(matching, "--model"), "old-model");
    assert.equal(flag(matching, "--thinking"), "off");
    assert.ok(matching.includes("--continue"));
    assert.equal(flag(pinned, "--provider"), "original");
    assert.equal(flag(pinned, "--model"), "org/model");
    assert.equal(flag(pinned, "--thinking"), "high");
    for (const args of [pinned, legacy]) {
      assert.equal(args.includes("parent-secret"), false);
      assert.equal(args.includes("--api-key"), false);
    }
    for (const arg of ["--provider", "--model", "--thinking"]) assert.equal(legacy.includes(arg), false);
  }
});

test("legacy registry recovers first effective settings, never later resume settings, and persists thinking", async () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/named-settings-"));
  try {
    const entries = [
      { type: "session", id: "original" },
      { type: "model_change", provider: "original", modelId: "fuzzy" },
      { type: "thinking_level_change", thinkingLevel: "medium" },
      { type: "custom", customType: SUBAGENT_INTELLIGENCE_CUSTOM_TYPE, data: { intelligence: "old-label" } },
      { type: "message", message: { role: "user", content: "first task" } },
      { type: "message", message: { role: "assistant", provider: "original", model: "exact", thinkingLevel: "high" } },
      { type: "model_change", provider: "later", modelId: "wrong" },
      { type: "thinking_level_change", thinkingLevel: "off" },
      { type: "custom", customType: SUBAGENT_INTELLIGENCE_CUSTOM_TYPE, data: { intelligence: "later-label" } },
      { type: "message", message: { role: "user", content: "resume" } },
    ];
    fs.writeFileSync(path.join(root, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const file = path.join(root, "names.json");
    const [name] = await allocateSubagentNames(file, "owner", [
      { agent: "worker", task: "first task", sessionDir: root, model: "fuzzy" },
    ]);
    const record = readNamesRegistry(file).agents[name];
    assert.deepEqual(originalModelSettings(record), {
      model: "original/exact",
      thinking: "high",
      intelligence: "old-label",
    });
    assert.deepEqual(readOriginalSessionSettings(root), originalModelSettings(record));
    assert.deepEqual(
      originalModelSettings({ ...record, model: "original/fuzzy", thinking: "max" }),
      {
        model: "original/exact",
        thinking: "high",
        intelligence: "old-label",
      },
      "interrupted launches recover resolved models and clamped thinking, not requested settings",
    );
    const [modern] = await allocateSubagentNames(file, "owner", [
      { agent: "worker", task: "first task", sessionDir: path.join(root, "missing"), ...saved },
    ]);
    assert.deepEqual(originalModelSettings(readNamesRegistry(file).agents[modern]), saved);
    // Resume metadata inserted before a second prompt must not replace an interrupted first task.
    fs.writeFileSync(
      path.join(root, "session.jsonl"),
      entries
        .filter((_entry, index) => index !== 5)
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    assert.deepEqual(readOriginalSessionSettings(root), {
      model: "original/fuzzy",
      thinking: "medium",
      intelligence: "old-label",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
