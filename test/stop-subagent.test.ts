import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { readBudget } from "../budget.js";
import { registerStopSubagentTool } from "../extension/stop-tool.js";
import { schedulerFor, shutdownScheduler } from "../extension/scheduler.js";
import { loadSubagentSettings } from "../settings.js";
import { acquireNamesLock } from "../storage/names-lock.js";
import { readNamesRegistry } from "../names.js";
import { getNestedSubagentResults, isSubagentDetails } from "../types.js";
import { collectCombinedUsageStatusLine } from "../index.js";
import { fixture, deferred, until, text, gatedRunner, assertSuccess } from "./helpers/message-subagent.js";

async function stopFixture() {
  const f = await fixture();
  let captured: ToolDefinition | undefined;
  const register = f.state.pi.registerTool;
  f.state.pi.registerTool = (tool) => {
    captured = tool as unknown as ToolDefinition;
  };
  registerStopSubagentTool(f.state);
  f.state.pi.registerTool = register;
  assert.ok(captured);
  const tool = captured;
  return {
    ...f,
    stopTool: tool,
    stop: (args: unknown, signal?: AbortSignal) =>
      tool.execute("stop-call", args as Record<string, unknown>, signal, undefined, f.ctx),
    async close() {
      shutdownScheduler(f.state);
      await f.close();
    },
  };
}

function statuses(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  assert.ok(isSubagentDetails(result.details));
  return Reflect.get(result.details, "statuses");
}

test("stop_subagent validates string-or-array names at preparation and execution boundaries", async () => {
  const f = await stopFixture();
  try {
    assert.equal(f.stopTool.name, "stop_subagent");
    assert.ok(f.stopTool.prepareArguments);
    for (const name of [f.name, [f.name], [f.name, "other"], [f.name, f.name]]) {
      const args = { name };
      assert.deepEqual(f.stopTool.prepareArguments(args), args);
      assert.deepEqual(
        validateToolArguments(f.stopTool, {
          type: "toolCall",
          id: "sdk-stop",
          name: "stop_subagent",
          arguments: args,
        }),
        args,
      );
    }
    for (const invalid of [
      undefined,
      null,
      {},
      [],
      { name: "" },
      { name: " \n" },
      { name: [] },
      { name: [f.name, ""] },
      { name: [null] },
      { name: [1] },
      { name: [[f.name]] },
      { name: null },
      { name: 1 },
      { names: [f.name] },
      { name: f.name, message: "stop" },
    ]) {
      assert.throws(() => f.stopTool.prepareArguments!(invalid), /Invalid tool arguments/);
      assert.match(text(await f.stop(invalid)), /Invalid tool arguments/);
    }
    assert.equal(f.state.backgroundJobs.size, 0);
    assert.equal(schedulerFor(f.state).snapshot().length, 0);
  } finally {
    await f.close();
  }
});

test("stop reports idle and unknown names, deduplicates names and adds no worker usage", async () => {
  const f = await stopFixture();
  try {
    const result = await f.stop({ name: [f.name, "missing", f.name, "__proto__"] });
    assert.deepEqual(statuses(result), [
      { name: f.name, status: "idle" },
      { name: "missing", status: "unknown" },
      { name: "__proto__", status: "unknown" },
    ]);
    assert.ok(isSubagentDetails(result.details));
    assert.deepEqual(result.details.results, []);
    assert.equal(result.details.usageSummary?.subagentCount, 0);
    const entry = {
      id: "stop",
      type: "message",
      message: {
        role: "toolResult",
        toolName: "stop_subagent",
        toolCallId: "stop",
        content: result.content,
        details: result.details,
      },
    };
    assert.equal(getNestedSubagentResults([entry.message]).flatMap((item) => item.details.results).length, 0);
    assert.match(
      collectCombinedUsageStatusLine({
        sessionManager: {
          getEntries: () => [entry],
          getLeafId: () => "stop",
        },
      }) ?? "",
      /WITH SUBS: \(0\) Σ \$0\.0000/,
    );
  } finally {
    await f.close();
  }
});

test("stop kills matching handles before scheduler abort and remains usable when delegation is disabled", async () => {
  const f = await stopFixture();
  const gate = deferred();
  try {
    const order: string[] = [];
    const scheduler = schedulerFor(f.state);
    const named = scheduler.schedule(f.name, async () => gate.promise, {
      onCancel: () => {
        order.push("abort");
      },
    });
    const sibling = scheduler.schedule("sibling", async () => gate.promise);
    f.state.activeSubagents.set(1, {
      name: f.name,
      agent: "worker",
      task: "one",
      handle: {
        steer: () => true,
        kill: () => {
          order.push("kill");
        },
      },
    });
    f.state.activeSubagents.set(2, {
      name: "sibling",
      agent: "worker",
      task: "two",
      handle: {
        steer: () => true,
        kill: () => {
          assert.fail("must not kill sibling");
        },
      },
    });
    f.state.canDelegate = false;
    f.state.disabled = true;
    const before = readBudget(f.state.currentBudget!);
    assert.deepEqual(statuses(await f.stop({ name: [f.name, f.name] })), [{ name: f.name, status: "stopped" }]);
    assert.deepEqual(order, ["kill", "abort"]);
    assert.equal(named.controller.signal.aborted, true);
    assert.equal(sibling.controller.signal.aborted, false);
    assert.deepEqual(readBudget(f.state.currentBudget!), before);
    gate.resolve();
    await Promise.allSettled([named.promise, sibling.promise]);
    f.state.activeSubagents.clear();
    f.state.sessionActive = false;
    assert.match(text(await f.stop({ name: f.name })), /no active session/);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("stop removes queued tasks and resumes without admitting them or refunding reservations", async () => {
  const f = await stopFixture();
  const gate = deferred();
  try {
    f.write(f.agent, { limits: { concurrency: 1 } });
    f.state.settings = loadSubagentSettings(f.project, true);
    const scheduler = schedulerFor(f.state);
    const running = scheduler.schedule("blocker", async () => gate.promise);
    let starts = 0;
    let cleanup = 0;
    const first = scheduler.schedule(
      "queued-launch",
      async () => {
        starts++;
      },
      {
        onCancel: () => {
          cleanup++;
        },
      },
    );
    const resume = scheduler.schedule(
      f.name,
      async () => {
        starts++;
      },
      {
        onCancel: () => {
          cleanup++;
        },
      },
    );
    const before = readBudget(f.state.currentBudget!);
    const branchBefore = readBudget(f.budget);
    const result = await f.stop({ name: ["queued-launch", f.name, "missing"] });
    assert.deepEqual(statuses(result), [
      { name: "queued-launch", status: "canceled" },
      { name: f.name, status: "canceled" },
      { name: "missing", status: "unknown" },
    ]);
    assert.equal(cleanup, 2);
    assert.equal(running.controller.signal.aborted, false);
    assert.deepEqual(scheduler.snapshot(), [{ name: "blocker", status: "started" }]);
    await assert.rejects(first.promise);
    await assert.rejects(resume.promise);
    gate.resolve();
    await running.promise;
    await until(() => scheduler.snapshot().length === 0);
    assert.equal(starts, 0);
    assert.deepEqual(readBudget(f.state.currentBudget!), before);
    assert.deepEqual(readBudget(f.budget), branchBefore);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("stop during resume preparation cannot resurrect work after registry I/O completes", async () => {
  const f = await stopFixture();
  const unlock = await acquireNamesLock(f.state.currentNamesFile);
  try {
    const before = readBudget(f.state.currentBudget!);
    const resume = f.execute({ name: f.name, message: "must not start" });
    await until(() =>
      schedulerFor(f.state)
        .snapshot()
        .some((item) => item.name === f.name),
    );
    assert.deepEqual(statuses(await f.stop({ name: f.name })), [{ name: f.name, status: "canceled" }]);
    unlock();
    const result = await resume;
    assert.equal(Reflect.get(result, "isError"), true);
    assert.match(text(result), /abort/i);
    assert.equal(f.state.backgroundJobs.size, 0);
    assert.equal(f.state.activeResumeNames.size, 0);
    assert.deepEqual(schedulerFor(f.state).snapshot(), []);
    assert.equal(readNamesRegistry(f.state.currentNamesFile).agents[f.name].activeResumes, undefined);
    assert.deepEqual(readBudget(f.state.currentBudget!), before);
  } finally {
    unlock();
    await f.close();
  }
});

test(
  "real launches share cancellation with queued resumes and leave siblings running",
  { timeout: 15000 },
  async () => {
    const f = await stopFixture();
    const runner = gatedRunner(f, true);
    f.write(path.join(f.project, ".pi"), { limits: { concurrency: 1 } });
    f.state.settings = loadSubagentSettings(f.project, true);
    Object.assign(f.ctx, { model: { provider: "original", id: "provider-model" } });
    try {
      const launch = await f.launch({
        tasks: [
          { task: "first", max_subagents_allowed: 0 },
          { task: "second", max_subagents_allowed: 0 },
          { task: "third", max_subagents_allowed: 0 },
        ],
      });
      assertSuccess(launch);
      assert.ok(isSubagentDetails(launch.details));
      const [first, second, third] = launch.details.results;
      assert.ok(first.name && second.name && third.name);
      await until(() => runner.runs().length === 1);
      const resume = await f.execute({ name: f.name, message: "follow-up" });
      assertSuccess(resume);
      await until(() =>
        schedulerFor(f.state)
          .snapshot()
          .some((item) => item.name === f.name && item.status === "queued"),
      );
      const before = readBudget(f.state.currentBudget!);
      assert.deepEqual(statuses(await f.stop({ name: [second.name, f.name] })), [
        { name: second.name, status: "canceled" },
        { name: f.name, status: "canceled" },
      ]);
      const controller = new AbortController();
      controller.abort();
      assert.match(text(await f.stop({ name: first.name }, controller.signal)), /abort/i);
      assert.equal(runner.runs().length, 1);
      assert.deepEqual(statuses(await f.stop({ name: first.name })), [{ name: first.name, status: "stopped" }]);
      await until(() => runner.runs().length === 2);
      assert.match(runner.runs()[1].prompt, /^third/);
      const active = Array.from(f.state.activeSubagents.values());
      assert.ok(active.some((worker) => worker.name === third.name));
      assert.ok(!active.some((worker) => worker.name === first.name));
      assert.deepEqual(readBudget(f.state.currentBudget!), before);
      runner.release("third");
      await until(() => f.state.backgroundJobs.size === 0);
      assert.equal(runner.runs().length, 2, "canceled launches and resumes must never restart");
      assert.equal(f.state.activeResumeNames.size, 0);
    } finally {
      runner.release("first");
      runner.release("second");
      runner.release("third");
      runner.release("follow-up");
      await f.close();
    }
  },
);
