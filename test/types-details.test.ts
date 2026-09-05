import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, buildSubagentDetails, getNestedSubagentResults } from "../types.js";
import { makeResult, makeTextMessage, makeToolCallMessage, makeToolResultMessage } from "./helpers/results.js";

describe("buildSubagentDetails", () => {
  test("builds correct structure for empty results", () => {
    const d = buildSubagentDetails("single", "spawn", "/project/agents", []);
    assert.equal(d.mode, "single");
    assert.equal(d.delegationMode, "spawn");
    assert.equal(d.projectAgentsDir, "/project/agents");
    assert.deepEqual(d.results, []);
    assert.deepEqual(d.aggregatedUsage, emptyUsage());
    assert.deepEqual(d.aggregatedToolCalls, {});
    assert.deepEqual(d.usageTree, []);
  });

  test("aggregates usage across results", () => {
    const r1 = makeResult({
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 1 },
    });
    const r2 = makeResult({
      usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 2 },
    });
    const d = buildSubagentDetails("parallel", "spawn", null, [r1, r2]);
    assert.equal(d.aggregatedUsage.input, 30);
    assert.equal(d.aggregatedUsage.turns, 3);
  });

  test("aggregates tool calls across results", () => {
    const r1 = makeResult({ toolCalls: { bash: 2, read: 1 } });
    const r2 = makeResult({ toolCalls: { bash: 1, write: 3 } });
    const d = buildSubagentDetails("parallel", "spawn", null, [r1, r2]);
    assert.equal(d.aggregatedToolCalls.bash, 3);
    assert.equal(d.aggregatedToolCalls.read, 1);
    assert.equal(d.aggregatedToolCalls.write, 3);
  });

  test("durable details omit usage tree nodes", () => {
    const r = makeResult({ agent: "my-agent" });
    const d = buildSubagentDetails("single", "spawn", null, [r]);
    assert.equal(d.usageTree.length, 0);
  });

  test("durable details keep final output but omit bulky non-subagent transcript text", () => {
    const r = makeResult({
      messages: [makeTextMessage("large final report"), makeToolCallMessage("bash", { command: "printf huge" })],
      stderr: "x".repeat(10000),
    });
    const d = buildSubagentDetails("single", "spawn", null, [r]);
    const stored = d.results[0];
    assert.equal(stored.finalOutput, "large final report");
    assert.equal(stored.messages.length, 0, "ordinary text/tool transcript is stored only in child session");
    assert.ok(stored.stderr.length < 5000, "stderr is tail-capped in parent details");
    assert.ok((stored.stderrTruncatedChars ?? 0) > 0);
  });

  test("durable completion data survives a JSON round-trip", () => {
    const usage = { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cost: 0.25, contextTokens: 99, turns: 2 };
    const d = buildSubagentDetails("single", "spawn", null, [
      makeResult({
        messages: [makeTextMessage("persist me")],
        usage,
        toolCalls: { read: 2 },
        model: "gpt-test",
        completedTurns: 2,
      }),
    ]);
    const parsed = JSON.parse(JSON.stringify(d));
    assert.equal(parsed.results[0].finalOutput, "persist me");
    assert.deepEqual(parsed.results[0].usage, usage);
    assert.deepEqual(parsed.results[0].toolCalls, { read: 2 });
    assert.equal(parsed.results[0].model, "gpt-test");
    assert.equal(parsed.results[0].completedTurns, 2);
    assert.equal(parsed.results[0].messages, undefined);
  });

  test("nested usage survives durable JSON round-trip and details rebuild", () => {
    const childUsage = { input: 5, output: 4, cacheRead: 3, cacheWrite: 2, cost: 0.1, contextTokens: 10, turns: 1 };
    const parentUsage = { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0.2, contextTokens: 20, turns: 1 };
    const nestedDetails = buildSubagentDetails("single", "spawn", null, [makeResult({ usage: childUsage })]);
    const parent = makeResult({
      usage: parentUsage,
      messages: [makeToolResultMessage("subagents", nestedDetails)],
    });
    const durable = JSON.parse(JSON.stringify(buildSubagentDetails("single", "spawn", null, [parent])));
    const rebuilt = buildSubagentDetails("single", "spawn", null, durable.results);
    assert.equal(rebuilt.usageSummary?.subagentCount, 2);
    assert.equal(rebuilt.usageSummary?.inputTokens, 16);
    assert.equal(rebuilt.usageSummary?.outputTokens, 11);
    assert.ok(Math.abs((rebuilt.usageSummary?.costUsd ?? 0) - 0.3) < 1e-9);
  });

  test("durable details omit nested subagent transcript/tree and keep only summaries", () => {
    const nestedDetails = buildSubagentDetails("single", "spawn", null, [makeResult({ agent: "child" })]);
    const parent = makeResult({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "not durable" },
            {
              type: "toolCall",
              name: "subagent",
              arguments: { tasks: [{ agent: "child", task: "work" }] },
              toolCallId: "nested",
            },
          ],
        },
        makeToolResultMessage("subagent", nestedDetails),
      ],
    });
    const d = buildSubagentDetails("single", "spawn", null, [parent]);
    const stored = d.results[0];
    assert.equal(stored.messages.length, 0);
    assert.deepEqual(d.usageTree, []);
    assert.equal(getNestedSubagentResults(stored.messages).length, 0);
  });
});
