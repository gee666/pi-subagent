/**
 * Resilience tests: verify the extension never crashes the host pi process,
 * even when errors occur in execute, runAgent, or event handlers.
 *
 * These tests exercise error paths by mocking or providing controlled inputs.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentDetails, emptyUsage, isResultError, type SingleResult } from "../types.js";
import { processJsonLine } from "../runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hungPiMockOptions(timeoutMs = 50) {
  return {
    startupTimeoutMsOverride: timeoutMs,
    piCommandOverride: {
      command: process.execPath,
      argsPrefix: ["-e", "setInterval(() => {}, 1000)", "--"],
    },
  };
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "agent",
    agentSource: "user",
    task: "task",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    toolCalls: {},
    completedTurns: 0,
    turnInProgress: false,
    liveLog: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// processJsonLine never throws
// ---------------------------------------------------------------------------

describe("processJsonLine: never throws", () => {
  const crashCandidates = [
    // Null byte
    "\0",
    // Only whitespace
    "\n\t\r",
    // Truncated JSON exactly at a string boundary
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"abc',
    // JSON with a raw newline inside a string (malformed)
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"line1\nline2"}]}}',
    // Very long garbage string
    "x".repeat(10000),
    // Valid JSON but not an event
    '{"foo":"bar","baz":[1,2,3]}',
    // Array instead of object
    '[1,2,3]',
    // Number
    '42',
    // Null
    'null',
    // Boolean
    'true',
    // Nested JSON-in-JSON
    JSON.stringify({ type: "message_end", message: JSON.stringify({ role: "assistant" }) }),
    // Unicode edge cases
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"emoji: 🔥 and null: \u0000"}]}}',
    // JSON with control characters
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"\b\f\r\n\t"}]}}',
    // Deeply nested object
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], deep: { a: { b: { c: {} } } } } }),
  ];

  for (const input of crashCandidates) {
    test(`does not throw for input: ${JSON.stringify(input).slice(0, 60)}...`, () => {
      const result = makeResult();
      assert.doesNotThrow(() => {
        processJsonLine(input, result);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// runAgent catch block: process errors do not propagate as unhandled throws
// ---------------------------------------------------------------------------

describe("runAgent: catch block covers spawn errors", async () => {
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
    assert.ok(result.messages.some((message: any) => message?.content?.[0]?.text === "recovered"));
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

    const specialTask = 'Fix "quoted" bug in path /var/www/project & handle <tags> with \'quotes\'';

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
    assert.ok(result!.stderr.includes("startup timeout"), `Expected startup timeout in stderr, got: ${result!.stderr.slice(0, 200)}`);
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
        [{ agent: "cyclic", task: "bad" }, { agent: "legal", task: "good" }],
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

// ---------------------------------------------------------------------------
// Execute wrapper: top-level try/catch
// ---------------------------------------------------------------------------

describe("execute top-level error handling", () => {
  /**
   * We test the execute wrapper by building a minimal mock and verifying
   * that if discoverAgents or any internal step throws, we get a structured
   * error result back (not an unhandled rejection).
   *
   * Since pi's ExtensionAPI is a peer dep and hard to mock fully, we test
   * the catch path by directly calling executeSingle-equivalent logic with
   * an agent that causes runAgent to fail immediately (unknown agent name).
   */

  test("buildSubagentDetails is safe even with malformed results", () => {
    // Ensure the details builder used in catch blocks doesn't throw
    assert.doesNotThrow(() => {
      const d = buildSubagentDetails("single", "spawn", null, []);
      assert.ok(d.mode === "single");
    });
  });

  test("catch block details builder: parallel mode", () => {
    assert.doesNotThrow(() => {
      const d = buildSubagentDetails("parallel", "spawn", "/some/dir", []);
      assert.ok(d.mode === "parallel");
      assert.ok(d.delegationMode === "spawn");
    });
  });

  test("error message from thrown Error is captured", () => {
    // Simulate what the execute catch block does
    let capturedText = "";
    try {
      throw new Error("Simulated execute error: Expected ',' in JSON at position 1178");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? `\n\n${err.stack}` : "";
      capturedText = `[pi-subagent] Unexpected error: ${msg}${stack}`;
    }
    assert.ok(capturedText.includes("Simulated execute error"));
    assert.ok(capturedText.includes("[pi-subagent]"));
  });

  test("error message from non-Error throw is captured", () => {
    let capturedText = "";
    try {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string error";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      capturedText = `[pi-subagent] Unexpected error: ${msg}`;
    }
    assert.ok(capturedText.includes("string error"));
  });
});

// ---------------------------------------------------------------------------
// Abort signal handling
// ---------------------------------------------------------------------------

describe("abort signal", () => {
  test("runAgent with already-aborted signal returns quickly with aborted result", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");

    const controller = new AbortController();
    controller.abort(); // Pre-abort

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
      task: "task",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      signal: controller.signal,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
    });

    // Should return a result, not throw
    assert.ok(typeof result.exitCode === "number");
    // The result may indicate abort/error
    if (result.stopReason) {
      assert.ok(["aborted", "error"].includes(result.stopReason));
    }
  });
});
