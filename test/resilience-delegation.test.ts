import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentDetails, isResultError } from "../types.js";
import { makeResult } from "./fixtures/resilience.js";

describe("runAgent delegation recovery", () => {
  test("a recovered nested delegation failure does not poison the calling agent", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
    const nestedFailure = buildSubagentDetails("single", "spawn", null, [
      makeResult({
        agent: "cyclic-agent",
        exitCode: 1,
        stopReason: "error",
        errorMessage: "Delegation cycle detected",
        stderr: "Delegation cycle detected",
      }),
    ]);
    const events = [
      { type: "turn_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "subagents",
              arguments: { tasks: [{ agent: "cyclic-agent", task: "recurse" }] },
              toolCallId: "nested-call",
            },
          ],
          stopReason: "toolUse",
          usage,
        },
      },
      {
        type: "tool_result_end",
        message: {
          role: "toolResult",
          toolName: "subagents",
          toolCallId: "nested-call",
          isError: true,
          content: [{ type: "text", text: "Delegation cycle detected" }],
          details: nestedFailure,
        },
      },
      { type: "turn_start" },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Recovered and completed directly." }],
          stopReason: "stop",
          usage,
        },
      },
      { type: "agent_end", willRetry: false },
      { type: "agent_settled" },
    ];
    const script = `${events.map((event) => `console.log(${JSON.stringify(JSON.stringify(event))})`).join(";")};setInterval(()=>{},1000)`;
    const fakeAgent = {
      name: "parent-agent",
      description: "test",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/path.md",
    };

    const result = await runAgent({
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      startupTimeoutMsOverride: 1_000,
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "parent-agent",
      task: "recover from a bad delegation",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.errorMessage, undefined);
    assert.ok(result.messages.some((message) => message?.role === "toolResult" && message.isError === true));
  });

  test("cycle prevention fails only the cyclic task before spawning", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const fakeAgent = {
      name: "fake-agent",
      description: "test",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/path.md",
    };
    const result = await runAgent({
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "recurse",
      parentDepth: 1,
      parentAgentStack: ["team-lead", "fake-agent"],
      maxDepth: 3,
      preventCycles: true,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /delegation cycle/i);
  });

  test("mixed parallel cycles do not block legal siblings", async () => {
    const { executeParallelSubprocess } = await import("../runner.js");
    const previousCommand = process.env.PI_SUBAGENT_PI_COMMAND;
    const previousPrefix = process.env.PI_SUBAGENT_PI_ARGS_PREFIX;
    const script = [
      `const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}}`,
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"legal completed"}],stopReason:"stop",usage}}))`,
      `console.log(JSON.stringify({type:"agent_end",willRetry:false}))`,
      `console.log(JSON.stringify({type:"agent_settled"}))`,
      `setInterval(()=>{},1000)`,
    ].join(";");
    process.env.PI_SUBAGENT_PI_COMMAND = process.execPath;
    process.env.PI_SUBAGENT_PI_ARGS_PREFIX = JSON.stringify(["-e", script, "--"]);
    const agents = ["cyclic", "legal"].map((name) => ({
      name,
      description: "test",
      systemPrompt: "",
      source: "user" as const,
      filePath: `/fake/${name}.md`,
    }));
    try {
      const result = await executeParallelSubprocess(
        [
          { agent: "cyclic", task: "bad" },
          { agent: "legal", task: "good" },
        ],
        agents,
        "/tmp",
        1,
        3,
        ["team-lead", "cyclic"],
        true,
        undefined,
        undefined,
        (results) => buildSubagentDetails("parallel", "spawn", null, results),
      );
      assert.equal(result.details.results[0].exitCode, 1);
      assert.equal(result.details.results[1].exitCode, 0);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Parallel: 1\/2 succeeded/);
    } finally {
      if (previousCommand === undefined) delete process.env.PI_SUBAGENT_PI_COMMAND;
      else process.env.PI_SUBAGENT_PI_COMMAND = previousCommand;
      if (previousPrefix === undefined) delete process.env.PI_SUBAGENT_PI_ARGS_PREFIX;
      else process.env.PI_SUBAGENT_PI_ARGS_PREFIX = previousPrefix;
    }
  });

  test("resuming an unfinished durable result preserves pre-crash descendant usage", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const script = [
      `const usage={input:2,output:1,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{total:0.02}}`,
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"resumed"}],stopReason:"stop",usage}}))`,
      `console.log(JSON.stringify({type:"agent_end",willRetry:false}))`,
      `console.log(JSON.stringify({type:"agent_settled"}))`,
      `setInterval(()=>{},1000)`,
    ].join(";");
    const fakeAgent = {
      name: "fake-agent",
      description: "test",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/path.md",
    };
    const initial = makeResult({
      agent: "fake-agent",
      exitCode: -1,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 15, turns: 1 },
      subtreeUsageSummary: {
        subagentCount: 2,
        inputTokens: 17,
        outputTokens: 8,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.17,
        turns: 2,
      },
      sessionDir: "/tmp",
    });
    const result = await runAgent({
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "resume",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      resumeSession: true,
      sessionDir: "/tmp",
      initialResult: initial,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });
    const details = buildSubagentDetails("single", "spawn", null, [result]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(details.usageSummary?.subagentCount, 2);
    assert.equal(details.usageSummary?.inputTokens, 19);
    assert.equal(details.usageSummary?.outputTokens, 9);
    assert.ok(Math.abs((details.usageSummary?.costUsd ?? 0) - 0.19) < 1e-9);
  });

  test("unknown agent returns structured error result", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");

    const result = await runAgent({
      cwd: "/tmp",
      agents: [],
      agentName: "does-not-exist",
      task: "task",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.equal(result.exitCode, 1);
    assert.ok(isResultError(result));
    assert.ok(result.stderr.includes("does-not-exist"));
    // Must NOT throw
  });
});
