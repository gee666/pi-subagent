import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentDetails, type SingleResult } from "../types.js";

function hungPiMockOptions(timeoutMs = 50) {
  return {
    startupTimeoutMsOverride: timeoutMs,
    piCommandOverride: {
      command: process.execPath,
      argsPrefix: ["-e", "setInterval(() => {}, 1000)", "--"],
    },
  };
}

describe("runAgent startup failures", () => {
  test("rejected initial RPC prompts fail immediately without startup retries", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");
    const script = `let b="";process.stdin.on("data",d=>{b+=d;const i=b.indexOf("\\n");if(i<0)return;const c=JSON.parse(b.slice(0,i));console.log(JSON.stringify({id:c.id,type:"response",command:"prompt",success:false,error:"No API key"}))});setInterval(()=>{},1000)`;
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
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: "reject",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.ok(Date.now() - started < 1_000);
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /prompt rejected.*No API key/i);
    assert.doesNotMatch(result.stderr, /startup timeout/i);
  });

  test("startup timeout kills a hung subprocess", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");

    const specialTask = "Fix \"quoted\" bug in path /var/www/project & handle <tags> with 'quotes'";

    const fakeAgent = {
      name: "fake-agent",
      description: "test",
      systemPrompt: "You are a test agent.",
      source: "user" as const,
      filePath: "/fake/path.md",
    };

    // Use a short startup timeout with a deterministic hung child process.
    const result: SingleResult = await runAgent({
      ...hungPiMockOptions(),
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: specialTask,
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    // The extension must have killed the process and returned a result
    // (not hung forever). Verify it's a valid SingleResult.
    assert.ok(result! !== undefined);
    assert.ok(typeof result!.exitCode === "number");
    assert.ok(typeof result!.stderr === "string");
    assert.ok(Array.isArray(result!.messages));
    // Should mention startup timeout in stderr
    assert.ok(
      result!.stderr.includes("startup timeout"),
      `Expected startup timeout in stderr, got: ${result!.stderr.slice(0, 200)}`,
    );
    assert.equal(result!.exitCode, 1);
    assert.equal(result!.stopReason, "error");
  });

  test("startup timeout works with special characters in task", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");

    const taskWithNewlines = "Fix the bug:\n- Step 1: find it\n- Step 2: fix it\n- Step 3: test it";

    const fakeAgent = {
      name: "fake-agent",
      description: "test",
      systemPrompt: "",
      source: "user" as const,
      filePath: "/fake/path.md",
    };

    const result: SingleResult = await runAgent({
      ...hungPiMockOptions(),
      cwd: "/tmp",
      agents: [fakeAgent],
      agentName: "fake-agent",
      task: taskWithNewlines,
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    assert.ok(result! !== undefined);
    assert.ok(typeof result!.exitCode === "number");
    assert.ok(result!.stderr.includes("startup timeout"));
    assert.equal(result!.exitCode, 1);
    assert.equal(result!.stopReason, "error");
  });
});
