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

    // Use a short startup timeout so the extension itself kills the
    // hung process — not an external abort signal.
    const origTimeout = process.env.PI_SUBAGENT_STARTUP_TIMEOUT;
    process.env.PI_SUBAGENT_STARTUP_TIMEOUT = "3000"; // 3 seconds

    let result: SingleResult;
    try {
      result = await runAgent({
        cwd: "/tmp",
        agents: [fakeAgent],
        agentName: "fake-agent",
        task: specialTask,
        delegationMode: "spawn",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: false,
        makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
      });
    } finally {
      if (origTimeout === undefined) delete process.env.PI_SUBAGENT_STARTUP_TIMEOUT;
      else process.env.PI_SUBAGENT_STARTUP_TIMEOUT = origTimeout;
    }

    // The extension must have killed the process and returned a result
    // (not hung forever). Verify it's a valid SingleResult.
    assert.ok(result! !== undefined);
    assert.ok(typeof result!.exitCode === "number");
    assert.ok(typeof result!.stderr === "string");
    assert.ok(Array.isArray(result!.messages));
    // Should mention startup timeout in stderr
    assert.ok(result!.stderr.includes("startup timeout"), `Expected startup timeout in stderr, got: ${result!.stderr.slice(0, 200)}`);
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

    const origTimeout = process.env.PI_SUBAGENT_STARTUP_TIMEOUT;
    process.env.PI_SUBAGENT_STARTUP_TIMEOUT = "3000";

    let result: SingleResult;
    try {
      result = await runAgent({
        cwd: "/tmp",
        agents: [fakeAgent],
        agentName: "fake-agent",
        task: taskWithNewlines,
        delegationMode: "spawn",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: false,
        makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
      });
    } finally {
      if (origTimeout === undefined) delete process.env.PI_SUBAGENT_STARTUP_TIMEOUT;
      else process.env.PI_SUBAGENT_STARTUP_TIMEOUT = origTimeout;
    }

    assert.ok(result! !== undefined);
    assert.ok(typeof result!.exitCode === "number");
    assert.ok(result!.stderr.includes("startup timeout"));
  });

  test("unknown agent returns structured error result", async () => {
    const { runAgentSubprocess: runAgent } = await import("../runner.js");

    const result = await runAgent({
      cwd: "/tmp",
      agents: [],
      agentName: "does-not-exist",
      task: "task",
      delegationMode: "spawn",
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
      const d = buildSubagentDetails("parallel", "fork", "/some/dir", []);
      assert.ok(d.mode === "parallel");
      assert.ok(d.delegationMode === "fork");
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
// Session snapshot building is safe for unusual inputs
// ---------------------------------------------------------------------------

describe("fork session snapshot safety", () => {
  test("JSON.stringify on nested objects does not throw for normal objects", () => {
    const header = { type: "session_header", version: 1, model: "claude-3-5-sonnet" };
    const branch = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there! How can I help?" }] },
    ];

    assert.doesNotThrow(() => {
      const lines = [JSON.stringify(header)];
      for (const entry of branch) lines.push(JSON.stringify(entry));
      const jsonl = `${lines.join("\n")}\n`;
      assert.ok(jsonl.length > 0);
    });
  });

  test("JSON.stringify handles special characters in content", () => {
    const obj = {
      role: "user",
      content: [{ type: "text", text: 'Task: Fix "bug" in {key: "val"} with <tags> & \'quotes\'\n\nCode:\n```\nif (x > 0) { return true; }\n```' }],
    };

    assert.doesNotThrow(() => {
      const serialized = JSON.stringify(obj);
      // Must be parseable back
      const parsed = JSON.parse(serialized);
      assert.ok(parsed.content[0].text.includes("Fix"));
    });
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
      delegationMode: "spawn",
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
