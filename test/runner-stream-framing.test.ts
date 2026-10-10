import assert from "node:assert/strict";
import { test } from "node:test";
import { runAttempt } from "../runner/attempt.js";
import type { RunAgentOptions } from "../runner/options.js";
import { makeRunningResult } from "./helpers/results.js";

function options(code: string): RunAgentOptions {
  return {
    cwd: process.cwd(),
    agents: [],
    agentName: "test-agent",
    task: "test framing",
    parentDepth: 0,
    parentAgentStack: [],
    maxDepth: 3,
    preventCycles: false,
    settings: {},
    startupTimeoutMsOverride: 5000,
    idleTimeoutMsOverride: 0,
    terminationTimeoutMsOverride: 1000,
    piCommandOverride: { command: process.execPath, argsPrefix: ["-e", code, "--"] },
    makeDetails: () => {
      throw new Error("no progress details should be built");
    },
  };
}

test("attempt drains fragmented UTF-8 JSONL and an unterminated settled record", { timeout: 10000 }, async () => {
  const text = "😀 λ 終 \u2028 \u2029".repeat(20000);
  const code = `
    const text = "😀 λ 終 \\u2028 \\u2029".repeat(20000);
    const wire = Buffer.from(
      JSON.stringify({type: "turn_start"}) + "\\r\\n\\nmalformed\\n" +
      JSON.stringify({type: "message_end", message: {role: "assistant", content: [{type: "text", text}], stopReason: "stop"}}) + "\\r\\n" +
      JSON.stringify({type: "agent_settled"}) + "\\r"
    );
    (async () => {
      for (let offset = 0; offset < wire.length; offset += 257) {
        await new Promise((resolve, reject) => process.stdout.write(wire.subarray(offset, offset + 257), error => error ? reject(error) : resolve()));
      }
      process.stdout.end();
    })();
  `;
  const result = makeRunningResult();
  const outcome = await runAttempt(options(code), result, [], "test", 0, () => {});
  assert.equal(outcome.exitCode, 0, result.stderr);
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0].content, [{ type: "text", text }]);
  assert.equal(result.usage.turns, 1);
});

test("attempt retains the final message when a child closes without LF or settlement", { timeout: 10000 }, async () => {
  const code = `process.stdout.end(JSON.stringify({type: "message_end", message: {role: "user", content: "final 😀"}}));`;
  const result = makeRunningResult();
  const outcome = await runAttempt(options(code), result, [], "test", 0, () => {});
  assert.equal(outcome.exitCode, 1, "unexpected exit classification must remain intact");
  assert.deepEqual(result.messages, [{ role: "user", content: "final 😀" }]);
});
