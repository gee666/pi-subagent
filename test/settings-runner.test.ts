import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runAgentSubprocess, executeParallelSubprocess, type RunAgentOptions } from "../runner.js";
import { buildSubagentDetails, getFinalOutput } from "../types.js";
import { resolveChildExtensionArgs } from "../runner/arguments.js";
import { settingsFixture } from "./helpers/settings.js";

const agent = { name: "worker", description: "worker", source: "user" as const, filePath: "/unused", systemPrompt: "" };

function options(cwd: string): RunAgentOptions {
  return {
    cwd,
    agents: [agent],
    agentName: "worker",
    task: "work",
    parentDepth: 0,
    parentAgentStack: [],
    maxDepth: 3,
    preventCycles: true,
    makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    terminationTimeoutMsOverride: 20,
  };
}

const script = `
  process.stdin.once("data", () => {
    const value = {
      args: process.argv.slice(1),
      depth: process.env.PI_SUBAGENT_DEPTH,
      maxDepth: process.env.PI_SUBAGENT_MAX_DEPTH,
      cycles: process.env.PI_SUBAGENT_PREVENT_CYCLES,
      budget: process.env.PI_SUBAGENT_BUDGET_DIR,
      command: process.env.PI_SUBAGENT_PI_COMMAND
    };
    console.log(JSON.stringify({type:"message_end", message: {
      role:"assistant", content:[{type:"text",text:JSON.stringify(value)}], stopReason:"stop"
    }}));
    console.log(JSON.stringify({type:"agent_settled"}));
  });
`;

test("runner settings reach real subprocess command, args, fallback and authoritative child grants", async () => {
  const f = settingsFixture();
  try {
    f.write(f.agent, {
      runner: {
        command: process.execPath,
        argsPrefix: ["-e", script, "--"],
        startupTimeoutMs: 0,
        idleTimeoutMs: 0,
        startupRetries: 0,
      },
      models: { fallback: "local/configured" },
      delegation: { depth: 100, preventCycles: false },
    });
    const result = await runAgentSubprocess({
      ...options(f.project),
      parentDepth: 1,
      maxDepth: 2,
      preventCycles: true,
    });
    assert.equal(result.exitCode, 0, result.errorMessage);
    const output = JSON.parse(getFinalOutput(result.messages));
    assert.equal(output.args[output.args.indexOf("--model") + 1], "local/configured");
    assert.equal(output.depth, "2");
    assert.equal(output.maxDepth, "2");
    assert.equal(output.cycles, "1");
    assert.equal(output.budget, "");
    assert.equal(output.command, undefined, "JSON is not injected into env");
    process.env.PI_SUBAGENT_FALLBACK_MODEL = "env/model";
    const override = await runAgentSubprocess(options(f.project));
    assert.equal(override.model, "env/model");
    assert.equal(process.env.PI_SUBAGENT_PI_COMMAND, undefined);
  } finally {
    f.close();
  }
});

test("startup timeout/retries and idle timeout use JSON without import-time snapshots", async () => {
  const f = settingsFixture();
  try {
    const log = path.join(f.root, "attempts");
    const hang = `require("node:fs").appendFileSync(${JSON.stringify(log)}, "start\\n"); setInterval(() => {}, 1000);`;
    f.write(f.agent, {
      runner: {
        command: process.execPath,
        argsPrefix: ["-e", hang, "--"],
        startupTimeoutMs: 2000,
        startupRetries: 0,
        idleTimeoutMs: 0,
      },
    });
    const startup = await runAgentSubprocess(options(f.project));
    assert.match(startup.errorMessage ?? "", /startup timeout.*2000ms/);
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
    const idle =
      'process.stdin.once("data", () => console.log(JSON.stringify({type:"turn_start"}))); setInterval(() => {}, 1000);';
    f.write(f.agent, {
      runner: {
        command: process.execPath,
        argsPrefix: ["-e", idle, "--"],
        startupTimeoutMs: 5000,
        idleTimeoutMs: 20,
        startupRetries: 0,
      },
    });
    const stalled = await runAgentSubprocess(options(f.project));
    assert.match(stalled.errorMessage ?? "", /inactivity timeout.*20ms/);
    const success = await runAgentSubprocess({
      ...options(f.project),
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      idleTimeoutMsOverride: 0,
    });
    assert.equal(success.exitCode, 0, success.errorMessage);
  } finally {
    f.close();
  }
});

test("parallel capacity and concurrency use JSON, reject oversized batches before spawning", async () => {
  const f = settingsFixture();
  try {
    const log = path.join(f.root, "concurrency.jsonl");
    const delayed = `
      process.stdin.once("data", () => {
        const fs = require("node:fs");
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,event:"start"})+"\\n");
        setTimeout(() => {
          fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,event:"end"})+"\\n");
          console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}],stopReason:"stop"}}));
          console.log(JSON.stringify({type:"agent_settled"}));
        }, 30);
      });
    `;
    f.write(f.agent, {
      runner: { command: process.execPath, argsPrefix: ["-e", delayed, "--"] },
      limits: { parallel: 2, concurrency: 1 },
    });
    const makeDetails = (results: Parameters<RunAgentOptions["makeDetails"]>[0]) =>
      buildSubagentDetails("parallel", "spawn", null, results);
    const run = (count: number) =>
      executeParallelSubprocess(
        Array.from({ length: count }, () => ({ agent: "worker", task: "work" })),
        [agent],
        f.project,
        0,
        3,
        [],
        true,
        undefined,
        undefined,
        makeDetails,
      );
    assert.equal((await run(3)).isError, true);
    assert.equal(fs.existsSync(log), false);
    const result = await run(2);
    assert.equal(result.isError, undefined);
    const events = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    assert.deepEqual(events, ["start", "end", "start", "end"]);
    process.env.PI_SUBAGENT_MAX_PARALLEL_TASKS = "0";
    assert.equal((await run(1)).isError, true);
  } finally {
    f.close();
  }
});

test("SDK runner defaults fail closed on project settings; explicit trust loads them", async () => {
  const f = settingsFixture();
  try {
    f.write(path.join(f.project, ".pi"), {
      models: { fallback: "project/model" },
      runner: { command: "must-not-spawn" },
    });
    const base = {
      ...options(f.project),
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
    };
    const untrusted = await runAgentSubprocess(base);
    assert.equal(untrusted.exitCode, 0, untrusted.errorMessage);
    assert.equal(untrusted.model, undefined);
    assert.ok(JSON.parse(getFinalOutput(untrusted.messages)).args.includes("--no-approve"));
    const trusted = await runAgentSubprocess({ ...base, projectTrusted: true });
    assert.equal(trusted.exitCode, 0, trusted.errorMessage);
    assert.equal(trusted.model, "project/model");
    assert.ok(JSON.parse(getFinalOutput(trusted.messages)).args.includes("--approve"));
    const denied = await runAgentSubprocess({ ...base, projectTrusted: false });
    assert.ok(JSON.parse(getFinalOutput(denied.messages)).args.includes("--no-approve"));
  } finally {
    f.close();
  }
});

test("JSON extension exclusions are applied before any excluded factory executes", async () => {
  const f = settingsFixture();
  try {
    const extension = path.join(f.agent, "extensions", "excluded,hook.ts");
    const marker = path.join(f.root, "executed");
    fs.mkdirSync(path.dirname(extension));
    fs.writeFileSync(
      extension,
      `import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "unsafe"); export default function() {}`,
    );
    f.write(f.agent, { extension: { exclude: [extension] } });
    const args = await resolveChildExtensionArgs(f.project, false);
    assert.ok(args?.includes("--no-extensions"));
    assert.ok(args?.includes("--no-approve"));
    assert.equal(args?.includes(extension), false);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    f.close();
  }
});
