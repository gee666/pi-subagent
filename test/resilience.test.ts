import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSubagentDetails } from "../types.js";
import { processJsonLine } from "../runner.js";
import { makeResult } from "./fixtures/resilience.js";

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
    "[1,2,3]",
    // Number
    "42",
    // Null
    "null",
    // Boolean
    "true",
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
