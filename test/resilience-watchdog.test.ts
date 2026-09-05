import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentDetails } from "../types.js";

describe("runAgent inactivity watchdog", () => {
  test("post-startup inactivity kills a child stalled after a tool result", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const script = [
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"t1",toolName:"bash",args:{}}))`,
      `console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"t1",toolName:"bash"}))`,
      `setInterval(() => {}, 1000)`,
    ].join(";");
    const fakeAgent = {
      name: "fake-agent",
      description: "test",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/path.md",
    };

    const started = Date.now();
    const result = await runAgent({
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      startupTimeoutMsOverride: 1_000,
      idleTimeoutMsOverride: 50,
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "stall after the tool",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.ok(Date.now() - started < 2_000, "inactivity watchdog must settle promptly");
    assert.equal(result.exitCode, 1);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /inactivity timeout/i);
    assert.match(result.stderr, /inactivity timeout/i);
  });

  test("ongoing tool execution is exempt from the inactivity timeout", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const script = [
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"t1",toolName:"bash",args:{}}))`,
      `setTimeout(()=>{console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"t1",toolName:"bash"}));console.log(JSON.stringify({type:"agent_end",willRetry:false}));console.log(JSON.stringify({type:"agent_settled"}))},150)`,
      `setInterval(() => {}, 1000)`,
    ].join(";");
    const fakeAgent = {
      name: "fake-agent",
      description: "test",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/path.md",
    };

    const result = await runAgent({
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      startupTimeoutMsOverride: 1_000,
      idleTimeoutMsOverride: 50,
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "run a slow tool",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /inactivity timeout/i);
  });

  test("inactivity timeout stays paused until all concurrent tools end", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const script = [
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"t1",toolName:"read",args:{}}))`,
      `console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"t2",toolName:"bash",args:{}}))`,
      `setTimeout(()=>console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"t1",toolName:"read"})),20)`,
      `setTimeout(()=>{console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"t2",toolName:"bash"}));console.log(JSON.stringify({type:"agent_end",willRetry:false}));console.log(JSON.stringify({type:"agent_settled"}))},150)`,
      `setInterval(() => {}, 1000)`,
    ].join(";");
    const fakeAgent = {
      name: "fake-agent",
      description: "test",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/path.md",
    };

    const result = await runAgent({
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      startupTimeoutMsOverride: 1_000,
      idleTimeoutMsOverride: 50,
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "run concurrent slow tools",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /inactivity timeout/i);
  });

  test("streaming model deltas reset the inactivity watchdog", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const script = [
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `let count=0`,
      `const timer=setInterval(()=>{console.log(JSON.stringify({type:"message_update"}));if(++count===5){clearInterval(timer);console.log(JSON.stringify({type:"agent_end",willRetry:false}));console.log(JSON.stringify({type:"agent_settled"}))}},20)`,
    ].join(";");
    const fakeAgent = {
      name: "fake-agent",
      description: "test",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/path.md",
    };

    const result = await runAgent({
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      startupTimeoutMsOverride: 1_000,
      idleTimeoutMsOverride: 50,
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "stream slowly",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.stderr, /inactivity timeout/i);
  });
});
