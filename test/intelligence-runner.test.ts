import assert from "node:assert/strict";
import { test, before, after } from "node:test";
const originalEnabled = process.env.PI_SUBAGENT_INTELLIGENCE;
before(() => {
  process.env.PI_SUBAGENT_INTELLIGENCE = "true";
});
after(() => {
  if (originalEnabled === undefined) delete process.env.PI_SUBAGENT_INTELLIGENCE;
  else process.env.PI_SUBAGENT_INTELLIGENCE = originalEnabled;
});
import { execFileSync } from "node:child_process";
import { buildPiArgs } from "../runner/arguments.js";
import { runAgentSubprocess, executeParallelSubprocess, type RunAgentOptions } from "../runner.js";
import { parseIntelligencePresets } from "../intelligence.js";
import { buildLiveSubagentDetails, buildSubagentDetails, getFinalOutput, type SingleResult } from "../types.js";
import { makeResult } from "./helpers/results.js";

const presets = parseIntelligencePresets([
  { junior: { model: "org/model", provider: "chosen", "reasoning-level": "high" } },
  { tiny: { model: "small", provider: "local", "reasoning-level": "off" } },
]);
const agent = {
  name: "worker",
  description: "worker",
  source: "user" as const,
  filePath: "/fake",
  systemPrompt: "Review code",
  model: "legacy/model",
  thinking: "low",
};
const script = `process.stdin.once("data", () => {
  const message = { role: "assistant", content: [{type:"text",text:JSON.stringify(process.argv.slice(1))}], stopReason:"stop" };
  process.stdout.write(JSON.stringify({type:"message_end",message}) + "\\n");
  process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");
});`;
const options: RunAgentOptions = {
  cwd: process.cwd(),
  agents: [agent],
  agentName: agent.name,
  task: "Review architecture",
  parentDepth: 0,
  parentAgentStack: [],
  maxDepth: 3,
  preventCycles: true,
  fallbackModel: "parent/current",
  intelligencePresets: presets,
  makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
  piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
  startupTimeoutMsOverride: 5000,
};
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test("caller preset reaches subprocess launches and resumes without mutation or network routing", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  for (const resumeSession of [false, true]) {
    for (const preset of presets) {
      const result = await runAgentSubprocess({
        ...options,
        intelligence: preset.name,
        resumeSession,
        sessionDir: process.cwd(),
      });
      assert.equal(result.exitCode, 0, result.errorMessage);
      const args = JSON.parse(getFinalOutput(result.messages)) as string[];
      assert.equal(flag(args, "--provider"), preset.provider);
      assert.equal(flag(args, "--model"), preset.model);
      assert.equal(flag(args, "--thinking"), preset.thinking);
      assert.equal(args.includes("--continue"), resumeSession);
      assert.equal(result.model, `${preset.provider}/${preset.model}`);
      assert.equal(result.intelligence, preset.name);
    }
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(agent.model, "legacy/model");
  assert.equal(agent.thinking, "low");
});

test("omission preserves existing arguments even with presets configured", async () => {
  const original = buildPiArgs(agent, null, options.task, undefined, false, options.fallbackModel).args;
  for (const intelligencePresets of [undefined, presets]) {
    const result = await runAgentSubprocess({ ...options, intelligencePresets });
    assert.equal(result.exitCode, 0, result.errorMessage);
    const args = JSON.parse(getFinalOutput(result.messages)) as string[];
    args.splice(args.indexOf("--append-system-prompt"), 2);
    assert.deepEqual(args, original);
  }
});

test("invalid, unavailable, and disabled choices fail without spawning; cancellation remains aborted", async () => {
  const noSpawn = { command: "must-not-spawn-nonexistent-command" };
  for (const intelligencePresets of [undefined, presets]) {
    const result = await runAgentSubprocess({
      ...options,
      intelligencePresets,
      intelligence: "missing",
      piCommandOverride: noSpawn,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage!, /Unknown|disabled/);
    assert.doesNotMatch(result.errorMessage!, /ENOENT/);
  }
  const previous = process.env.PI_SUBAGENT_INTELLIGENCE;
  try {
    process.env.PI_SUBAGENT_INTELLIGENCE = "false";
    const result = await runAgentSubprocess({ ...options, intelligence: "junior", piCommandOverride: noSpawn });
    assert.match(result.errorMessage!, /disabled/);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_INTELLIGENCE;
    else process.env.PI_SUBAGENT_INTELLIGENCE = previous;
  }
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runAgentSubprocess({
    ...options,
    intelligence: "junior",
    signal: controller.signal,
    piCommandOverride: noSpawn,
  });
  assert.equal(cancelled.exitCode, 130);
  assert.equal(cancelled.stopReason, "aborted");
});

test("selected providers remove inherited CLI credentials for separate and inline flags", () => {
  for (const cli of [
    ["--provider", "old", "--api-key", "old-secret"],
    ["--provider=old", "--api-key=old-secret"],
  ]) {
    const code = `
      process.argv = ["node", "pi", ...${JSON.stringify(cli)}, "--thinking", "low"];
      const { buildPiArgs } = await import("./runner/arguments.ts");
      const agent = ${JSON.stringify(agent)};
      const original = buildPiArgs(agent, null, "task", undefined, false).args;
      const selected = buildPiArgs(agent, null, "task", undefined, true, "parent/current", false,
        { provider: "chosen", model: "model", thinking: "off" }).args;
      console.log(JSON.stringify({ original, selected }));`;
    const { original, selected } = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], {
        cwd: process.cwd(),
        timeout: 10000,
        encoding: "utf8",
      }),
    ) as { original: string[]; selected: string[] };
    assert.equal(flag(original, "--provider"), "old");
    assert.equal(flag(original, "--api-key"), "old-secret");
    assert.equal(flag(selected, "--provider"), "chosen");
    assert.equal(selected.filter((arg) => arg === "--provider").length, 1);
    assert.equal(selected.includes("--api-key"), false);
    assert.equal(selected.includes("old-secret"), false);
    assert.equal(flag(selected, "--thinking"), "off");
  }
});

test("runner overrides inherited run metadata with the selection or explicit null", async () => {
  const previous = process.env.PI_SUBAGENT_RUN_INTELLIGENCE;
  process.env.PI_SUBAGENT_RUN_INTELLIGENCE = JSON.stringify("parent-label");
  try {
    const envScript = script.replace(
      "JSON.stringify(process.argv.slice(1))",
      "process.env.PI_SUBAGENT_RUN_INTELLIGENCE",
    );
    for (const intelligence of ["junior", undefined]) {
      const result = await runAgentSubprocess({
        ...options,
        intelligence,
        piCommandOverride: { command: process.execPath, argsPrefix: ["-e", envScript, "--"] },
      });
      assert.equal(JSON.parse(getFinalOutput(result.messages)), intelligence ?? null);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_RUN_INTELLIGENCE;
    else process.env.PI_SUBAGENT_RUN_INTELLIGENCE = previous;
  }
});

test("recovered and named continuations label the current selection, not the previous run", async () => {
  const initialResult = makeResult({ intelligence: "junior", exitCode: 130, stopReason: "aborted" });
  for (const [intelligence, expected] of [
    [undefined, undefined],
    ["tiny", "tiny"],
  ] as const) {
    const result = await runAgentSubprocess({ ...options, initialResult, resumeSession: true, intelligence });
    assert.equal(result.intelligence, expected);
    assert.equal(initialResult.intelligence, "junior", "earlier persisted result is unchanged");
    const persisted = JSON.parse(JSON.stringify(options.makeDetails([result])));
    assert.equal(persisted.results[0].intelligence, expected);
  }
});

test("a sole preset is automatic for launch and recovery while disabled presets act like zero", async () => {
  for (const resumeSession of [false, true]) {
    const automatic = await runAgentSubprocess({ ...options, intelligencePresets: [presets[0]], resumeSession });
    assert.equal(automatic.intelligence, "junior");
    assert.equal(flag(JSON.parse(getFinalOutput(automatic.messages)), "--model"), "org/model");
    process.env.PI_SUBAGENT_INTELLIGENCE = "false";
    try {
      const disabled = await runAgentSubprocess({ ...options, intelligencePresets: [presets[0]], resumeSession });
      assert.equal(disabled.intelligence, undefined);
      assert.equal(flag(JSON.parse(getFinalOutput(disabled.messages)), "--model"), "parent/current");
    } finally {
      process.env.PI_SUBAGENT_INTELLIGENCE = "true";
    }
  }
});

test("parallel initial and queued updates label pending launches and named resumes without relabeling reused results", async () => {
  const variables = {
    PI_SUBAGENT_PI_COMMAND: process.execPath,
    PI_SUBAGENT_PI_ARGS_PREFIX: JSON.stringify(["-e", script, "--"]),
    PI_SUBAGENT_MAX_CONCURRENCY: "1",
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    for (const [intelligencePresets, choice, expected] of [
      [presets, "tiny", "tiny"],
      [[presets[0]], undefined, "junior"],
      [presets, undefined, undefined],
      [[], undefined, undefined],
    ] as const) {
      const completed = makeResult({ agent: "worker", task: "done", intelligence: "historic", exitCode: 0 });
      const interrupted = makeResult({
        agent: "worker",
        task: "resume",
        name: "Ada",
        intelligence: "old",
        exitCode: 130,
      });
      const updates: SingleResult[][] = [];
      const result = await executeParallelSubprocess(
        [
          { agent: "worker", task: "done", intelligence: choice },
          { agent: "worker", task: "resume", intelligence: choice },
          { agent: "worker", task: "queued", intelligence: choice },
        ],
        [agent],
        process.cwd(),
        0,
        3,
        [],
        false,
        undefined,
        (update) => updates.push(structuredClone(update.details!.results)),
        (results) => buildLiveSubagentDetails("parallel", "spawn", null, results),
        [completed, interrupted],
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        { intelligencePresets: [...intelligencePresets], names: ["Reused", "Ada", "Grace"], rawPrompts: true },
      );
      assert.equal(result.isError, undefined);
      assert.ok(updates.length > 2);
      for (const index of [1, 2]) {
        assert.equal(updates[0][index].intelligence, expected, "initial update includes pending selections");
      }
      assert.equal(updates[0][1].name, "Ada");
      assert.equal(updates[0][2].name, "Grace");
      const queued = updates.find((results) => results[1].exitCode === -1 && results[2].messages.length === 0);
      assert.ok(queued, "second worker dispatch emits an update while the third is still queued");
      assert.equal(queued[2].intelligence, expected);
      assert.equal(queued[2].name, "Grace");
      for (const update of updates) assert.equal(update[0].intelligence, "historic");
      assert.equal(result.details.results[0], completed, "completed recovery result is reused unchanged");
      assert.equal(interrupted.intelligence, "old", "pending labels must not mutate saved results");
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("finished parallel recovery results remain reusable without a process", async () => {
  const saved = makeResult({
    agent: "worker",
    task: "work",
    intelligence: "tiny",
    exitCode: 0,
    stopReason: "stop",
    errorMessage: undefined,
  });
  const result = await executeParallelSubprocess(
    [{ agent: "worker", task: "work", intelligence: "junior" }],
    [agent],
    process.cwd(),
    0,
    3,
    [],
    false,
    undefined,
    undefined,
    options.makeDetails,
    [saved],
    undefined,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    { intelligencePresets: presets },
  );
  assert.equal(result.details.results[0].exitCode, 0);
  assert.equal(result.details.results[0].intelligence, "tiny", "reused sibling keeps its own earlier label");
  assert.deepEqual(result.details.results[0].usage, saved.usage);
  assert.equal(result.isError, undefined);
});
