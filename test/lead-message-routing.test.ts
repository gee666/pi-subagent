import assert from "node:assert/strict";
import { test } from "node:test";
import { executeParallelSubprocess } from "../runner/parallel.js";
import { runAttempt } from "../runner/attempt.js";
import { makeRunningResult } from "./helpers/results.js";
import { buildLiveSubagentDetails, type SingleResult } from "../types.js";
import { SUBAGENT_DEPTH_ENV } from "../runner/constants.js";

const agent = { name: "worker", description: "test", systemPrompt: "", source: "builtin" as const, filePath: "" };
const makeDetails = (results: SingleResult[]) => buildLiveSubagentDetails("parallel", "spawn", null, results);
const toolUrl = new URL("../extension/lead-message-tool.ts", import.meta.url).href;

const childCode = `
  process.stdin.once("data", async () => {
    const {createLeadMessageTool} = await import(${JSON.stringify(toolUrl)});
    await createLeadMessageTool().execute("notify", {message: "child finding"}, undefined, undefined, {});
    process.stdout.write(JSON.stringify({type: "message_end", message: {role: "assistant", content: "done", stopReason: "stop"}}) + "\\n");
    process.stdout.write(JSON.stringify({type: "agent_settled"}) + "\\n");
  });
`;

const settings = {
  PI_SUBAGENT_PI_COMMAND: process.execPath,
  PI_SUBAGENT_PI_ARGS_PREFIX: JSON.stringify(["--import", "tsx/esm", "-e", childCode, "--"]),
  PI_SUBAGENT_MAX_CONCURRENCY: "2",
};

test(
  "parallel notifications retain originating task identity without awaiting delivery",
  { timeout: 10000 },
  async () => {
    const tasks = [
      { agent: "worker", task: "first" },
      { agent: "worker", task: "second" },
    ];
    const received: Array<{ index: number; task: string; message: string }> = [];
    const result = await executeParallelSubprocess(
      tasks,
      [agent],
      process.cwd(),
      0,
      3,
      [],
      false,
      undefined,
      undefined,
      makeDetails,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        settings,
        onLeadMessage(index, task, message) {
          received.push({ index, task: task.task, message });
          return new Promise<void>(() => {});
        },
      },
    );
    assert.deepEqual(
      received.sort((a, b) => a.index - b.index),
      [
        { index: 0, task: "first", message: "child finding" },
        { index: 1, task: "second", message: "child finding" },
      ],
    );
    assert.equal(result.isError, undefined);
    assert.ok(result.details.results.every((result) => result.exitCode === 0 && result.stderr === ""));
    assert.ok(result.details.results.every((result) => result.messages.length === 1));
  },
);

test(
  "a nested lead receives its child's notification without automatically forwarding it upstream",
  { timeout: 10000 },
  async () => {
    const inheritedDepth = process.env[SUBAGENT_DEPTH_ENV];
    const attemptUrl = new URL("../runner/attempt.ts", import.meta.url).href;
    const resultsUrl = new URL("./helpers/results.ts", import.meta.url).href;
    const code = `
    process.stdin.once("data", async () => {
      const {runAttempt} = await import(${JSON.stringify(attemptUrl)});
      const {makeRunningResult} = await import(${JSON.stringify(resultsUrl)});
      const {createLeadMessageTool} = await import(${JSON.stringify(toolUrl)});
      const received = [];
      const result = makeRunningResult();
      await runAttempt({
        cwd: process.cwd(), agents: [], agentName: "nested-worker", task: "nested",
        parentDepth: 1, parentAgentStack: ["lead"], maxDepth: 3, preventCycles: false,
        settings: {}, startupTimeoutMsOverride: 5000, idleTimeoutMsOverride: 0, terminationTimeoutMsOverride: 1000,
        piCommandOverride: {command: process.execPath, argsPrefix: ["--import", "tsx/esm", "-e", ${JSON.stringify(childCode)}, "--"]},
        onLeadMessage: (message) => { received.push(message); },
        makeDetails: () => { throw new Error("no details expected"); },
      }, result, [], "nested task", 0, () => {});
      await createLeadMessageTool().execute("notify", {message: "own message to upstream"}, undefined, undefined, {});
      process.stdout.write(JSON.stringify({type: "message_end", message: {role: "assistant", content: JSON.stringify(received), stopReason: "stop"}}) + "\\n");
      process.stdout.write(JSON.stringify({type: "agent_settled"}) + "\\n");
    });
  `;
    const upstreamMessages: string[] = [];
    const result = makeRunningResult();
    const outcome = await runAttempt(
      {
        cwd: process.cwd(),
        agents: [],
        agentName: "lead",
        task: "lead task",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: false,
        settings: {},
        startupTimeoutMsOverride: 5000,
        idleTimeoutMsOverride: 0,
        terminationTimeoutMsOverride: 1000,
        piCommandOverride: { command: process.execPath, argsPrefix: ["--import", "tsx/esm", "-e", code, "--"] },
        onLeadMessage: (message) => {
          upstreamMessages.push(message);
        },
        makeDetails: () => {
          throw new Error("no details expected");
        },
      },
      result,
      [],
      "task",
      0,
      () => {},
    );
    assert.equal(outcome.exitCode, 0, result.stderr);
    assert.deepEqual(upstreamMessages, ["own message to upstream"]);
    assert.equal(result.messages[0].content, JSON.stringify(["child finding"]));
    assert.equal(result.stderr, "");
    // The parent never mutates its own environment while preparing a child transport.
    assert.equal(process.env[SUBAGENT_DEPTH_ENV], inheritedDepth);
  },
);
