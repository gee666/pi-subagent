import assert from "node:assert/strict";
import test from "node:test";
import { executeParallelSubprocess } from "../runner/parallel.js";
import type { DetailsFactory, RunningSubagentHandle } from "../runner/options.js";
import { buildLiveSubagentDetails, buildSubagentDetails, emptyUsage } from "../types.js";
import { makeResult } from "./helpers/results.js";

const agent = { name: "worker", description: "test", systemPrompt: "", source: "builtin" as const, filePath: "" };
const childCode = `
  let buffer = "";
  const emit = event => console.log(JSON.stringify(event));
  process.stdin.on("data", chunk => {
    buffer += chunk.toString();
    const lines = buffer.split("\\n"); buffer = lines.pop() || "";
    for (const line of lines) {
      const command = JSON.parse(line);
      emit({type:"response", command:"prompt", id:command.id, success:true});
      if (command.message === "slow") { emit({type:"turn_start"}); continue; }
      emit({type:"message_end", message:{role:"user", content:"PRIVATE_TRANSCRIPT".repeat(10000)}});
      emit({type:"message_end", message:{role:"assistant", content:[{type:"text", text:"done"}], stopReason:"stop", usage:{input:3, cost:{total:2}}}});
      emit({type:"agent_settled"});
    }
  });
`;
const settings = {
  PI_SUBAGENT_PI_COMMAND: process.execPath,
  PI_SUBAGENT_PI_ARGS_PREFIX: JSON.stringify(["-e", childCode, "--"]),
  PI_SUBAGENT_MAX_CONCURRENCY: "2",
};
const durable: DetailsFactory = (results) => buildSubagentDetails("parallel", "spawn", null, results);

test(
  "an async batch releases a finished child's transcript while its sibling still runs",
  { timeout: 10000 },
  async () => {
    const controller = new AbortController();
    const handles: RunningSubagentHandle[] = [];
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let compactSnapshot!: () => void;
    const compactPromise = new Promise<void>((resolve) => {
      compactSnapshot = resolve;
    });
    let childSnapshots = 0,
      completeSnapshots = 0;
    const factory: DetailsFactory = (results) => durable(results);
    factory.live = (results) => {
      if (results.length === 1) childSnapshots++;
      return buildLiveSubagentDetails("parallel", "spawn", null, results);
    };
    const operation = executeParallelSubprocess(
      [
        { agent: "worker", task: "fast" },
        { agent: "worker", task: "slow" },
      ],
      [agent],
      process.cwd(),
      0,
      3,
      [],
      false,
      controller.signal,
      (partial) => {
        const [fast, slow] = partial.details.results;
        if (fast.exitCode === 0 && slow.exitCode === -1) {
          assert.equal(fast.messages.length, 0);
          assert.equal(fast.finalOutput, "done");
          assert.equal(fast.subtreeUsageSummary?.costUsd, 2);
          assert.equal(partial.details.aggregatedUsage.cost, 2);
          completeSnapshots++;
          compactSnapshot();
        }
      },
      factory,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      (index, _task, handle) => {
        handles[index] = handle;
        if (handles[0] && handles[1]) ready();
      },
      undefined,
      { compactCompletedResults: true, settings, rawPrompts: true },
    );
    try {
      await readyPromise;
      await compactPromise;
      assert.ok(completeSnapshots > 0);
      assert.equal(childSnapshots, 0, "single-worker events must not build trees before batch coalescing");
      assert.equal(await handles[1].steer("finish"), true);
      const result = await operation;
      assert.equal(result.isError, undefined);
      assert.equal(result.details.usageSummary?.costUsd, 4);
      assert.equal(result.details.aggregatedUsage.cost, 4);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_TRANSCRIPT"));
      assert.equal(
        Object.keys(result.details).includes("aggregatedUsage"),
        false,
        "compatibility aggregates stay non-enumerable",
      );
    } finally {
      controller.abort();
      await operation;
    }
  },
);

test("background infrastructure failure aborts and drains siblings before returning", { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const handles: RunningSubagentHandle[] = [];
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const stopped: number[] = [];
  const operation = executeParallelSubprocess(
    [
      { agent: "worker", task: "slow" },
      { agent: "worker", task: "slow" },
    ],
    [agent],
    process.cwd(),
    0,
    3,
    [],
    false,
    controller.signal,
    undefined,
    durable,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    (index, _task, handle) => {
      handles[index] = handle;
      if (handles[0] && handles[1]) ready();
    },
    (index) => {
      stopped.push(index);
    },
    {
      settings,
      rawPrompts: true,
      cancelOnError: true,
      onResult(index) {
        if (index === 0) throw new Error("completion storage failed");
      },
    },
  );
  const rejected = assert.rejects(operation, /completion storage failed/);
  try {
    await readyPromise;
    assert.equal(await handles[0].steer("finish"), true);
    await rejected;
    assert.deepEqual(stopped.sort(), [0, 1], "both child lifecycles are settled before background cleanup");
    assert.equal(await handles[1].steer("too late"), false);
  } finally {
    controller.abort();
    await rejected;
  }
});

test("parallel calls without observers build no per-event progress details", { timeout: 10000 }, async () => {
  let calls = 0;
  const factory: DetailsFactory = (results) => {
    calls++;
    return durable(results);
  };
  const result = await executeParallelSubprocess(
    [{ agent: "worker", task: "fast" }],
    [agent],
    process.cwd(),
    0,
    3,
    [],
    false,
    undefined,
    undefined,
    factory,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    { settings, rawPrompts: true },
  );
  assert.equal(result.isError, undefined);
  assert.equal(calls, 1, "only the durable final details should be constructed");
});

test("compacting completed subtrees preserves canonical and compatibility accounting", async () => {
  const nested = makeResult({ name: "nested", usage: { ...emptyUsage(), cost: 4, input: 7 } });
  const parent = makeResult({
    name: "parent",
    usage: { ...emptyUsage(), cost: 2, input: 3 },
    messages: [
      { role: "toolResult", toolName: "subagents", details: buildSubagentDetails("single", "spawn", null, [nested]) },
    ],
  });
  const result = await executeParallelSubprocess(
    [{ agent: "worker", task: "saved" }],
    [],
    process.cwd(),
    0,
    3,
    [],
    false,
    undefined,
    undefined,
    durable,
    [parent],
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    { settings: {}, compactCompletedResults: true },
  );
  assert.equal(result.details.usageSummary?.costUsd, 6);
  assert.equal(result.details.aggregatedUsage.cost, 6);
  assert.equal(result.details.aggregatedUsage.input, 10);
  assert.equal(result.details.results[0].usage.cost, 2, "own usage must not become subtree usage");
  assert.equal(result.details.results[0].subtreeUsageSummary?.costUsd, 6);
});

test("stderr-only failures still explain the error after async transcript release", { timeout: 10000 }, async () => {
  const failedCode = `
    process.stdin.on("data", () => {
      process.stderr.write("specific tool failure\\n");
      console.log(JSON.stringify({type:"message_end", message:{role:"assistant", content:[], stopReason:"error"}}));
      console.log(JSON.stringify({type:"agent_settled"}));
    });
  `;
  const result = await executeParallelSubprocess(
    [{ agent: "worker", task: "fail" }],
    [agent],
    process.cwd(),
    0,
    3,
    [],
    false,
    undefined,
    undefined,
    durable,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      settings: { ...settings, PI_SUBAGENT_PI_ARGS_PREFIX: JSON.stringify(["-e", failedCode, "--"]) },
      compactCompletedResults: true,
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /specific tool failure/);
  assert.match(result.details.results[0].errorMessage!, /specific tool failure/);
  assert.equal(result.details.results[0].messages.length, 0);
});
