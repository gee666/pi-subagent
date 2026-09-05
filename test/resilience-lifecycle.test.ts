import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isRecord } from "../types/records.js";
import { buildSubagentDetails } from "../types.js";

describe("runAgent retry and process cleanup", () => {
  test("agent_end does not terminate a child before Pi auto-retry settles", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const usage = `{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}}`;
    const script = [
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"WebSocket error",usage:${usage}}}))`,
      `console.log(JSON.stringify({type:"agent_end",willRetry:true}))`,
      `console.log(JSON.stringify({type:"auto_retry_start",attempt:1,maxAttempts:3,delayMs:10,errorMessage:"WebSocket error"}))`,
      `setTimeout(()=>{console.log(JSON.stringify({type:"turn_start"}));console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"recovered"}],stopReason:"stop",usage:${usage}}}));console.log(JSON.stringify({type:"agent_end",willRetry:false}));console.log(JSON.stringify({type:"agent_settled"}))},20)`,
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
      idleTimeoutMsOverride: 200,
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "recover transport",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.errorMessage, undefined, "successful retry must clear the transient error");
    assert.ok(
      result.messages.some(
        (message) =>
          Array.isArray(message.content) && isRecord(message.content[0]) && message.content[0].text === "recovered",
      ),
    );
  });

  test("a launcher exit code caused by cleanup does not fail a settled agent", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const script = [
      `const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}}`,
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}],stopReason:"stop",usage}}))`,
      `console.log(JSON.stringify({type:"agent_end",willRetry:false}))`,
      `console.log(JSON.stringify({type:"agent_settled"}))`,
      // Shell/npm launchers commonly encode the runner's expected SIGTERM as
      // 128 + 15. The settled model result, not that cleanup code, is decisive.
      `setImmediate(()=>process.exit(143))`,
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
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "settle before launcher cleanup",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stopReason, "stop");
    assert.equal(result.errorMessage, undefined);
  });

  test("agent_settled waits for bounded process-tree termination", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const script = [
      `process.on("SIGTERM",()=>{})`,
      `const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}}`,
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}],stopReason:"stop",usage}}))`,
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
    const started = Date.now();
    const result = await runAgent({
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      startupTimeoutMsOverride: 1_000,
      terminationTimeoutMsOverride: 50,
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "settle",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.ok(Date.now() - started >= 40, "runner must not resolve immediately on agent_settled");
    assert.ok(Date.now() - started < 1_000, "SIGKILL escalation must remain bounded");
    assert.equal(result.exitCode, 0, result.stderr);
  });

  test("unexpected exit bounds inherited stdout held by a descendant", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const grandchild = `process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`;
    const script = [
      `const {spawn}=require("node:child_process")`,
      `spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:["ignore","inherit","ignore"]})`,
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `setTimeout(()=>process.exit(0),10)`,
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
      idleTimeoutMsOverride: 1_000,
      terminationTimeoutMsOverride: 50,
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "unexpected exit",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.ok(Date.now() - started < 1_000);
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /before agent_settled/i);
    assert.doesNotMatch(result.errorMessage ?? "", /inactivity timeout/i);
  });
});
