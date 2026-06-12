/**
 * Verifies that the running-subagent steering handle delivers messages via the
 * RPC "prompt" command with streamingBehavior "steer".
 *
 * Pi's raw "steer" RPC command calls session.steer() directly, which bypasses
 * the `input` extension hook. The child's pi-subagent extension must see
 * encoded nested-broadcast messages in its input hook to forward them to its
 * own children, so the handle must go through the prompt path instead.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runAgentSubprocess } from "../runner.js";
import { buildSubagentDetails } from "../types.js";
import type { AgentConfig } from "../agents.js";

const makeDetails = (results: any[]) =>
  buildSubagentDetails("single", "spawn", null, results);

const fakeAgent: AgentConfig = {
  name: "test-agent",
  description: "test",
  systemPrompt: "hello",
  source: "user" as const,
  filePath: "/fake",
};

/**
 * Mock pi process: collects the first two RPC lines received on stdin, echoes
 * them back inside an assistant message, then ends the agent.
 */
const echoRpcScript = `
const received = [];
let buf = "";
function finish() {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(received) }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  };
  process.stdout.write(JSON.stringify({ type: "message_end", message: msg }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");
}
process.stdin.on("data", (d) => {
  buf += d.toString();
  const lines = buf.split("\\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    received.push(line);
    if (received.length === 2) finish();
  }
});
`;

describe("subagent steering handle RPC transport", () => {
  test("handle.steer sends a prompt command with streamingBehavior steer (not a raw steer command)", async () => {
    const result = await runAgentSubprocess({
      cwd: process.cwd(),
      agents: [fakeAgent],
      agentName: "test-agent",
      task: "test task",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      makeDetails,
      piCommandOverride: {
        command: process.execPath,
        argsPrefix: ["-e", echoRpcScript, "--"],
      },
      onHandle: (handle) => {
        handle.steer("steer me");
      },
    });

    assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`);
    const assistant: any = result.messages.find((m: any) => m.role === "assistant");
    assert.ok(assistant, "expected the mock to echo an assistant message");
    const received: any[] = JSON.parse(assistant.content[0].text).map((line: string) => JSON.parse(line));

    // No raw "steer" RPC commands at all — they bypass the input hook.
    assert.ok(
      !received.some((cmd) => cmd.type === "steer"),
      `expected no raw steer commands, got: ${JSON.stringify(received)}`,
    );

    const steered = received.find((cmd) => cmd.message === "steer me");
    assert.ok(steered, `expected the steering message to arrive, got: ${JSON.stringify(received)}`);
    assert.equal(steered.type, "prompt");
    assert.equal(steered.streamingBehavior, "steer");

    // The initial task prompt is still delivered as a plain prompt.
    const initial = received.find((cmd) => typeof cmd.message === "string" && cmd.message.includes("test task"));
    assert.ok(initial, "expected the initial task prompt");
    assert.equal(initial.type, "prompt");
  });
});
