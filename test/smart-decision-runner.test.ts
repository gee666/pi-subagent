import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { buildPiArgs } from "../runner/arguments.js";
import { runAgentSubprocess, type RunAgentOptions } from "../runner.js";
import { parseSmartDecisionConfig } from "../runner/smart-decision.js";
import { buildSubagentDetails, getFinalOutput } from "../types.js";

const config = parseSmartDecisionConfig({
  enabled: true,
  model: "jev",
  api_key: "secret",
  use_models: [{ "chosen/org/model/high": "Architecture", "fast/tiny/off": "Small tasks" }],
})!;
const agent = {
  name: "worker",
  description: "worker",
  source: "user" as const,
  filePath: "/fake",
  systemPrompt: "Review code",
  model: "legacy/model",
  thinking: "low",
};
const script = `
process.stdin.once("data", () => {
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
  makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
  piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
  startupTimeoutMsOverride: 5000,
};
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test("Jev choice reaches subprocess CLI for launches and resumes without mutating the agent", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ answers: { model: { type: "choice", choice: "chosen/org/model/high" } } }),
  );
  for (const resumeSession of [false, true]) {
    const result = await runAgentSubprocess({
      ...options,
      smartDecision: config,
      resumeSession,
      sessionDir: process.cwd(),
    });
    assert.equal(result.exitCode, 0, result.errorMessage);
    const args = JSON.parse(getFinalOutput(result.messages)) as string[];
    assert.equal(flag(args, "--provider"), "chosen");
    assert.equal(flag(args, "--model"), "org/model");
    assert.equal(flag(args, "--thinking"), "high");
    assert.equal(args.includes("--continue"), resumeSession);
  }
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(agent.model, "legacy/model");
  assert.equal(agent.thinking, "low");
});

test("disabled selection and Jev failures with default fallback preserve original arguments", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unavailable");
  });
  const warn = t.mock.method(console, "warn", () => {});
  const original = buildPiArgs(agent, null, options.task, undefined, false, options.fallbackModel).args;
  for (const smartDecision of [undefined, config]) {
    const result = await runAgentSubprocess({ ...options, smartDecision });
    assert.equal(result.exitCode, 0, result.errorMessage);
    const args = JSON.parse(getFinalOutput(result.messages)) as string[];
    const promptIndex = args.indexOf("--append-system-prompt");
    args.splice(promptIndex, 2);
    assert.deepEqual(args, original);
  }
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(warn.mock.callCount(), 1);
});

test("strict Jev failure returns an error without spawning and cancellation remains aborted", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("secret");
  });
  const noSpawn = { command: "must-not-spawn-nonexistent-command" };
  const result = await runAgentSubprocess({
    ...options,
    smartDecision: { ...config, fallback: false },
    piCommandOverride: noSpawn,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /Fallback is disabled/);
  assert.doesNotMatch(result.errorMessage!, /secret|ENOENT/);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runAgentSubprocess({
    ...options,
    smartDecision: config,
    signal: controller.signal,
    piCommandOverride: noSpawn,
  });
  assert.equal(cancelled.exitCode, 130);
  assert.equal(cancelled.stopReason, "aborted");
});

test("smart selection removes inherited provider credentials but disabled behavior keeps them", () => {
  const code = `
    process.argv = ["node", "pi", "--provider", "old", "--api-key", "old-secret", "--thinking", "low"];
    const { buildPiArgs } = await import("./runner/arguments.ts");
    const agent = ${JSON.stringify(agent)};
    const original = buildPiArgs(agent, null, "task", undefined, false).args;
    const selected = buildPiArgs(agent, null, "task", undefined, false, "parent/current", false,
      { provider: "chosen", model: "model", thinking: "off" }).args;
    console.log(JSON.stringify({ original, selected }));
  `;
  const output = execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], {
    cwd: process.cwd(),
    timeout: 10000,
    encoding: "utf8",
  });
  const { original, selected } = JSON.parse(output) as { original: string[]; selected: string[] };
  assert.equal(flag(original, "--provider"), "old");
  assert.equal(flag(original, "--api-key"), "old-secret");
  assert.equal(flag(selected, "--provider"), "chosen");
  assert.equal(selected.filter((arg) => arg === "--provider").length, 1);
  assert.equal(selected.includes("--api-key"), false);
  assert.equal(selected.includes("old-secret"), false);
  assert.equal(flag(selected, "--thinking"), "off");
});

test("invalid enabled configuration obeys fallback without sending a request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not call");
  });
  const warnings = t.mock.method(console, "warn", () => {});
  for (const fallback of [true, false]) {
    const smartDecision = parseSmartDecisionConfig({
      enabled: true,
      fallback,
      model: "jev",
      api_key: "",
      use_models: [{ "p/m/high": "test" }],
    });
    const result = await runAgentSubprocess({ ...options, smartDecision });
    assert.equal(result.exitCode, fallback ? 0 : 1);
    if (!fallback) assert.match(result.errorMessage!, /Fallback is disabled/);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(warnings.mock.callCount(), 1);
});
