import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentDetails } from "../types.js";

const fakeAgent = {
  name: "fake-agent",
  description: "test",
  systemPrompt: "",
  source: "user" as const,
  filePath: "/fake/path.md",
};

async function run(script: string, task: string) {
  const { runAgentSubprocess: runAgent } = await import("../runner.js");
  return runAgent({
    piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
    startupTimeoutMsOverride: 1_000,
    cwd: "/tmp",
    agents: [fakeAgent],
    agentName: "fake-agent",
    task,
    parentDepth: 0,
    parentAgentStack: [],
    maxDepth: 3,
    preventCycles: false,
    makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
  });
}

// Provider stalls are bounded inside Pi (HTTP/WebSocket idle timeouts, auto-retry);
// rate-limit waits and tools may legitimately be silent for hours. The runner
// must not kill a started child merely for being quiet.
describe("runAgent has no post-startup inactivity watchdog", () => {
  test("a child silent after a tool result (e.g. waiting out a rate limit) is not killed", async () => {
    const script = [
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"t1",toolName:"bash",args:{}}))`,
      `console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"t1",toolName:"bash"}))`,
      `setTimeout(()=>{console.log(JSON.stringify({type:"agent_end",willRetry:false}));console.log(JSON.stringify({type:"agent_settled"}))},1500)`,
      `setInterval(() => {}, 1000)`,
    ].join(";");
    const result = await run(script, "wait quietly after the tool");
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /inactivity timeout/i);
  });

  test("a silent long-running tool is not killed", async () => {
    const script = [
      `console.log(JSON.stringify({type:"turn_start"}))`,
      `console.log(JSON.stringify({type:"tool_execution_start",toolCallId:"t1",toolName:"bash",args:{}}))`,
      `setTimeout(()=>{console.log(JSON.stringify({type:"tool_execution_end",toolCallId:"t1",toolName:"bash"}));console.log(JSON.stringify({type:"agent_end",willRetry:false}));console.log(JSON.stringify({type:"agent_settled"}))},1500)`,
      `setInterval(() => {}, 1000)`,
    ].join(";");
    const result = await run(script, "run a slow tool");
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /inactivity timeout/i);
  });
});
