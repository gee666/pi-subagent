import assert from "node:assert/strict";
import { test } from "node:test";
import { executeParallelSubprocess } from "../runner/parallel.js";
import type { DetailsFactory, OnUpdateCallback, RunningSubagentHandle } from "../runner/options.js";
import { emptyUsage, type SingleResult, type SubagentDetails } from "../types.js";
import { makeResult } from "./helpers/results.js";

const agent = { name: "worker", description: "test", systemPrompt: "", source: "builtin" as const, filePath: "" };
const tasks = [
  { agent: "worker", task: "first" },
  { agent: "worker", task: "second" },
];

function details(results: SingleResult[]): SubagentDetails {
  return {
    mode: "parallel",
    delegationMode: "spawn",
    projectAgentsDir: null,
    results,
    aggregatedUsage: emptyUsage(),
    aggregatedToolCalls: {},
    usageTree: [],
  };
}

function run(options: {
  onUpdate?: OnUpdateCallback;
  makeDetails: DetailsFactory;
  signal?: AbortSignal;
  resumeResults?: SingleResult[];
  getSessionDir?: (index: number) => string | undefined;
  onHandle?: (index: number, task: { agent: string; task: string }, handle: RunningSubagentHandle) => void;
  onTaskDone?: (index: number) => void;
  settings?: Record<string, string>;
}) {
  return executeParallelSubprocess(
    tasks,
    [agent],
    process.cwd(),
    0,
    3,
    [],
    false,
    options.signal,
    options.onUpdate,
    options.makeDetails,
    options.resumeResults,
    options.getSessionDir,
    false,
    undefined,
    undefined,
    options.onHandle,
    options.onTaskDone,
    { settings: options.settings ?? {} },
  );
}

const childCode = `
  let buffer = "", started = false;
  process.stdin.on("data", chunk => {
    buffer += chunk.toString();
    const lines = buffer.split("\\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const command = JSON.parse(line);
      if (command.type !== "prompt") continue;
      console.log(JSON.stringify({type: "response", command: "prompt", id: command.id, success: true}));
      if (command.message === "finish") {
        console.log(JSON.stringify({type: "message_end", message: {role: "assistant", content: [{type: "text", text: "done"}], stopReason: "stop"}}));
        console.log(JSON.stringify({type: "agent_settled"}));
      } else if (!started) {
        started = true;
        console.log(JSON.stringify({type: "turn_start"}));
        for (let i = 0; i < 100; i++) console.log(JSON.stringify({type: "message_end", message: {role: "user", content: String(i)}}));
      }
    }
  });
`;
const childSettings = {
  PI_SUBAGENT_PI_COMMAND: process.execPath,
  PI_SUBAGENT_PI_ARGS_PREFIX: JSON.stringify(["-e", childCode, "--"]),
  PI_SUBAGENT_MAX_CONCURRENCY: "2",
};

test(
  "parallel siblings coalesce before snapshots, heartbeat shares the limiter, completion flushes",
  { timeout: 10000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const handles: RunningSubagentHandle[] = [];
    const partials = new Map<string, SingleResult>();
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let childSnapshots = 0,
      batchSnapshots = 0;
    const factory: DetailsFactory = details;
    factory.live = (results) => {
      if (results.length === 1) {
        childSnapshots++;
        partials.set(results[0].task, results[0]);
        if (partials.size === 2 && [...partials.values()].every((result) => result.messages.length === 100)) ready();
      } else batchSnapshots++;
      return details(results);
    };
    t.after(() => {
      delete factory.live;
    });
    const updates: Array<{ at: number; counts: number[]; codes: number[] }> = [];
    const operation = run({
      signal: controller.signal,
      settings: childSettings,
      makeDetails: factory,
      onHandle: (index, _task, handle) => {
        handles[index] = handle;
      },
      onUpdate: (update) =>
        updates.push({
          at: Date.now(),
          counts: update.details.results.map((result) => result.messages.length),
          codes: update.details.results.map((result) => result.exitCode),
        }),
    });
    try {
      assert.deepEqual(updates, [{ at: 0, counts: [0, 0], codes: [-1, -1] }], "initial update is synchronous");
      await readyPromise;
      assert.ok(childSnapshots >= 200, "single-runner updates remain immediate");
      assert.equal(batchSnapshots, 1, "incoming siblings must not eagerly build batch snapshots");
      assert.equal(updates.length, 1);
      t.mock.timers.tick(100);
      assert.deepEqual(updates[1], { at: 100, counts: [100, 100], codes: [-1, -1] });
      t.mock.timers.tick(900);
      assert.deepEqual(
        updates[2],
        { at: 1000, counts: [100, 100], codes: [-1, -1] },
        "heartbeat still emits when quiet",
      );
      assert.deepEqual(await Promise.all(handles.map((handle) => handle.steer("finish"))), [true, true]);
      const result = await operation;
      assert.equal(result.isError, undefined);
      assert.deepEqual(
        updates[3],
        { at: 1000, counts: [101, 101], codes: [0, 0] },
        "final flush bypasses the remaining interval",
      );
      assert.equal(updates.length, 4);
      assert.equal(batchSnapshots, 4);
      t.mock.timers.tick(10000);
      assert.equal(updates.length, 4, "no queued callback after completion");
    } finally {
      controller.abort();
      await operation;
    }
  },
);

test("map failure drops queued progress and clears heartbeat", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  let snapshots = 0;
  const factory: DetailsFactory = (results) => {
    snapshots++;
    return details(results);
  };
  let updates = 0;
  await assert.rejects(
    run({
      makeDetails: factory,
      onUpdate: () => {
        updates++;
      },
      resumeResults: [makeResult({ agent: "worker", task: "first" })],
      getSessionDir: () => {
        throw new Error("preparation failed");
      },
    }),
    /preparation failed/,
  );
  assert.equal(updates, 1, "completed sibling queued an update but failed map must not flush it");
  assert.equal(snapshots, 1);
  t.mock.timers.tick(10000);
  assert.equal(updates, 1);
  assert.equal(snapshots, 1);
});

test("abort disposes pending progress and ignores subsequent child/completion requests", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const controller = new AbortController();
  let updates = 0;
  const result = await run({
    signal: controller.signal,
    makeDetails: details,
    onUpdate: () => {
      updates++;
    },
    resumeResults: [makeResult({ agent: "worker", task: "first" })],
    getSessionDir: () => {
      controller.abort();
      return undefined;
    },
  });
  assert.equal(result.isError, true);
  assert.deepEqual(
    result.details.results.map((item) => item.exitCode),
    [0, 130],
  );
  assert.equal(updates, 1);
  t.mock.timers.tick(10000);
  assert.equal(updates, 1);
});

test("successful resumed batch flushes once, while calls without onUpdate create no progress snapshots", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const resumeResults = tasks.map((task) => makeResult({ ...task, finalOutput: "saved answer" }));
  let liveSnapshots = 0,
    updates = 0;
  const factory: DetailsFactory = details;
  factory.live = (results) => {
    liveSnapshots++;
    return details(results);
  };
  t.after(() => {
    delete factory.live;
  });
  const result = await run({
    resumeResults,
    makeDetails: factory,
    onUpdate: () => {
      updates++;
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(updates, 2);
  assert.equal(liveSnapshots, 2);
  await run({ resumeResults, makeDetails: factory });
  t.mock.timers.tick(10000);
  assert.equal(updates, 2);
  assert.equal(liveSnapshots, 2);
});

test("late sibling updates after a map rejection cannot recreate queued progress", { timeout: 10000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const handles: RunningSubagentHandle[] = [];
  const partials = new Map<string, SingleResult>();
  let ready!: () => void, siblingDone!: () => void;
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const siblingDonePromise = new Promise<void>((resolve) => {
    siblingDone = resolve;
  });
  let snapshots = 0,
    updates = 0;
  const factory: DetailsFactory = (results) => details(results);
  factory.live = (results) => {
    if (results.length === 2) snapshots++;
    else {
      partials.set(results[0].task, results[0]);
      if (partials.size === 2 && [...partials.values()].every((result) => result.messages.length >= 100)) ready();
    }
    return details(results);
  };
  const operation = run({
    makeDetails: factory,
    signal: controller.signal,
    settings: childSettings,
    onUpdate: () => {
      updates++;
    },
    onHandle: (index, _task, handle) => {
      handles[index] = handle;
    },
    onTaskDone: (index) => {
      if (index === 0) throw new Error("task cleanup failed");
      siblingDone();
    },
  });
  // Attach the rejection observer before causing it while the sibling is still running.
  const rejected = assert.rejects(operation, /task cleanup failed/);
  try {
    await readyPromise;
    assert.equal(await handles[0].steer("finish"), true);
    await rejected;
    assert.equal(updates, 1);
    assert.equal(snapshots, 1);
    assert.equal(await handles[1].steer("finish"), true);
    await siblingDonePromise;
    assert.equal(partials.get("second")?.messages.length, 101, "late child state still accumulates");
    t.mock.timers.tick(10000);
    assert.equal(updates, 1);
    assert.equal(snapshots, 1, "late requests cannot build a stale batch snapshot");
  } finally {
    controller.abort();
    await rejected;
  }
});
