import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readBudget, reserveSubagentBudgets } from "../budget.js";
import { readNamesRegistry } from "../names.js";
import { isSubagentDetails } from "../types.js";
import { fixture, deferred, until, assertSuccess, text, gatedRunner, sdk } from "./helpers/message-subagent.js";

test("message_subagent registers one strict name/message payload and validates direct calls", async () => {
  const f = await fixture();
  try {
    assert.equal(f.tool.name, "message_subagent");
    assert.ok(f.tool.prepareArguments);
    const valid = { name: f.name, message: "continue", max_subagents_allowed: 0 };
    assert.deepEqual(f.tool.prepareArguments(valid), { ...valid, name: [valid.name] });
    const nullable = { ...valid, max_subagents_allowed: null };
    const prepared = f.tool.prepareArguments(nullable);
    const omitted = { name: [f.name], message: "continue" };
    assert.deepEqual(prepared, omitted);
    assert.deepEqual(sdk(f.tool, prepared), omitted);
    assert.equal(nullable.max_subagents_allowed, null, "SDK preparation must not mutate the provider payload");
    for (const invalid of [
      {},
      { name: f.name },
      { name: "", message: "hello" },
      { name: "  ", message: "hello" },
      { name: f.name, message: "" },
      { name: f.name, message: " \n" },
      { name: f.name, message: 1 },
      { resumes: [{ subagent: f.name, task: "hello" }] },
      { ...valid, intelligence: "other" },
      { ...valid, task: "old field" },
      ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER].map((amount) => ({
        ...valid,
        max_subagents_allowed: amount,
      })),
    ]) {
      assert.throws(() => f.tool.prepareArguments!(invalid), /Invalid tool arguments/);
      assert.match(text(await f.execute(invalid)), /Invalid tool arguments/);
    }
    assert.equal(f.state.backgroundJobs.size, 0);
    assert.equal(f.state.activeResumeNames.size, 0);
    assert.deepEqual(readBudget(f.budget), { limit: 2, remaining: 2 });
  } finally {
    await f.close();
  }
});

test("running messages steer immediately and resize the original grant without resetting spending", async () => {
  const f = await fixture();
  try {
    reserveSubagentBudgets(f.budget, "already-spent", [{ agent: "worker", task: "used", max_subagents_allowed: 0 }]);
    const messages: string[] = [];
    f.running((message) => {
      messages.push(message);
    });
    const rootBefore = readBudget(f.state.currentBudget!).remaining;
    assertSuccess(await f.execute({ name: f.name, message: "keep going" }));
    assert.deepEqual(readBudget(f.budget), { limit: 2, remaining: 1 });
    assertSuccess(await f.execute({ name: f.name, message: "expand", max_subagents_allowed: 4 }));
    assert.deepEqual(readBudget(f.budget), { limit: 4, remaining: 3 });
    assert.equal(readBudget(f.state.currentBudget!).remaining, rootBefore - 2);
    assertSuccess(await f.execute({ name: f.name, message: "reduce", max_subagents_allowed: 2 }));
    assert.deepEqual(readBudget(f.budget), { limit: 2, remaining: 1 });
    assert.equal(readBudget(f.state.currentBudget!).remaining, rootBefore - 2, "decreasing does not refund capacity");
    assert.match(
      text(await f.execute({ name: f.name, message: "invalid", max_subagents_allowed: 0 })),
      /already needs 1/,
    );
    assert.match(
      text(await f.execute({ name: f.name, message: "unfunded", max_subagents_allowed: 30 })),
      /extra slots/,
    );
    assert.deepEqual(messages, ["keep going", "expand", "reduce"]);
    assert.equal(f.state.backgroundJobs.size, 0);
    f.state.currentNamesFile = "";
    assertSuccess(await f.execute({ name: f.name, message: "without registry" }));
    assert.match(text(await f.execute({ name: f.name, message: "override", max_subagents_allowed: 3 })), /registry/);
  } finally {
    await f.close();
  }
});

test("messages wait for startup jobs to expose a handle and can cancel that wait", async () => {
  const f = await fixture();
  const gate = deferred();
  try {
    f.state.backgroundJobs.set("startup", {
      names: [f.name],
      controller: new AbortController(),
      promise: gate.promise,
    });
    const messages: string[] = [];
    let returned = false;
    const response = f.execute({ name: f.name, message: "during startup" }).then((result) => {
      returned = true;
      return result;
    });
    await delay(25);
    assert.equal(returned, false);
    assert.equal(f.state.activeResumeNames.size, 0);
    f.running((message) => {
      messages.push(message);
    });
    assertSuccess(await response);
    assert.deepEqual(messages, ["during startup"]);
    f.state.activeSubagents.clear();
    const controller = new AbortController();
    const cancelled = f.execute({ name: f.name, message: "cancelled" }, controller.signal);
    controller.abort();
    assert.match(text(await cancelled), /abort/i);
    assert.equal(f.state.backgroundJobs.get("startup")!.controller.signal.aborted, false);
    f.state.backgroundJobs.delete("startup");
    gate.resolve();
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("an awaited false from a settling handle waits for its background job before retrying", async () => {
  const f = await fixture();
  const gate = deferred();
  try {
    f.state.backgroundJobs.set("settling", {
      names: [f.name],
      controller: new AbortController(),
      promise: gate.promise,
    });
    let attempts = 0;
    let returned = false;
    f.running(
      async () => {
        attempts++;
        return false;
      },
      () => true,
    );
    const response = f.execute({ name: f.name, message: "follow-up" }).then((result) => {
      returned = true;
      return result;
    });
    await delay(25);
    assert.equal(attempts, 1);
    assert.equal(returned, false, "settling rejection must not report success");
    const delivered: string[] = [];
    f.running((message) => {
      delivered.push(message);
    });
    await delay(25);
    assert.equal(returned, false, "a replacement handle must not bypass the old job's settlement");
    assert.deepEqual(delivered, []);
    f.state.backgroundJobs.delete("settling");
    gate.resolve();
    assertSuccess(await response);
    assert.deepEqual(delivered, ["follow-up"]);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("an awaited false from a non-settling handle reports failed steering without waiting for its job", async () => {
  const f = await fixture();
  const ack = deferred(),
    done = deferred();
  const job = { names: [f.name], controller: new AbortController(), promise: done.promise };
  try {
    f.state.backgroundJobs.set("busy", job);
    f.running(
      async () => {
        await ack.promise;
        return false;
      },
      () => false,
    );
    let returned = false;
    const response = f.execute({ name: f.name, message: "rejected" }, AbortSignal.timeout(1000)).then((result) => {
      returned = true;
      return result;
    });
    await delay(25);
    assert.equal(returned, false, "tool success must wait for the steering acknowledgment");
    ack.resolve();
    const result = await response;
    assert.equal("isError" in result && result.isError, true);
    assert.match(text(result), /could not accept steering/);
    assert.doesNotMatch(text(result), /Message sent/);
    assert.equal(f.state.backgroundJobs.get("busy"), job, "delivery failure must not stop or replace the current job");
    assert.equal(job.controller.signal.aborted, false);
    assert.equal(f.state.activeResumeNames.size, 0);
  } finally {
    ack.resolve();
    done.resolve();
    await f.close();
  }
});

for (const fork of [false, true]) {
  test(
    `idle messaging starts background execution with original settings, fork ${fork}`,
    { timeout: 15000 },
    async () => {
      const f = await fixture();
      const runner = gatedRunner(f);
      if (fork) f.state.currentOwnerId = "another-owner";
      const owner = f.state.currentOwnerId;
      const namesFile = f.state.currentNamesFile;
      const controller = new AbortController();
      let toolUpdates = 0;
      try {
        const initial = readBudget(f.state.currentBudget!);
        const result = await f.execute(
          { name: f.name, message: "exact follow-up\nsecond line" },
          controller.signal,
          () => {
            toolUpdates++;
          },
        );
        assertSuccess(result);
        assert.match(text(result), /started.*background/);
        const job = Array.from(f.state.backgroundJobs.values()).find((job) => job.names.includes(f.name));
        assert.ok(job, "the tool returns while its worker is still pending");
        assert.equal(f.state.activeResumeNames.has(f.name), true);
        assert.ok(readNamesRegistry(namesFile).agents[f.name].activeResumes?.[owner]);
        controller.abort();
        assert.equal(job.controller.signal.aborted, false, "tool-call cancellation must not abort detached work");
        await until(() => runner.runs().length === 1);
        const run = runner.runs()[0];
        assert.equal(run.prompt, "exact follow-up\nsecond line");
        const flag = (name: string) => run.args[run.args.indexOf(name) + 1];
        assert.equal(flag("--provider"), "original");
        assert.equal(flag("--model"), "provider-model");
        assert.equal(flag("--thinking"), "high");
        assert.equal(run.intelligence, "old-label");
        assert.equal(run.budget, f.budget.directory);
        const record = readNamesRegistry(namesFile).agents[f.name];
        const resumedDir = fork ? record.forks[owner].sessionDir : f.sessionDir;
        assert.equal(flag("--session"), path.join(resumedDir, "session.jsonl"));
        if (fork) assert.notEqual(resumedDir, f.sessionDir);
        assert.deepEqual(readBudget(f.state.currentBudget!), initial, "resume does not allocate a new grant");
        assert.equal(record.lastResumePrompt, "exact follow-up\nsecond line");
        // Cleanup must use captured registry identity, not the next session's.
        if (fork) {
          f.state.lifecycleGeneration++;
          f.state.currentNamesFile = path.join(f.root, "next-session.json");
          f.state.currentOwnerId = "next-owner";
          f.state.activeResumeNames.clear();
          f.state.activeResumeNames.add(f.name);
        }
        runner.release();
        await job.promise;
        assert.equal(readNamesRegistry(namesFile).agents[f.name].activeResumes?.[owner], undefined);
        assert.equal(f.state.activeResumeNames.has(f.name), fork, "cleanup releases only the original session's guard");
        assert.equal(toolUpdates, 0, "background progress must not invoke the returned tool callback");
      } finally {
        await f.close();
      }
    },
  );
}

test(
  "a launched sibling can resume after onResult releases its name while the batch remains pending",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    const runner = gatedRunner(f, true);
    Object.assign(f.ctx, { model: { provider: "original", id: "provider-model" } });
    try {
      const launched = await f.launch({
        tasks: [
          { task: "fast", max_subagents_allowed: 0 },
          { task: "slow", max_subagents_allowed: 0 },
        ],
      });
      assertSuccess(launched);
      assert.ok(isSubagentDetails(launched.details));
      const [fast, slow] = launched.details.results;
      assert.ok(fast.name && slow.name);
      const batch = f.state.backgroundJobs.get("siblings")!;
      assert.deepEqual(batch.names, [fast.name, slow.name]);
      let batchDone = false;
      void batch.promise.then(() => {
        batchDone = true;
      });
      await until(() => runner.runs().length === 2);
      runner.release("fast");
      await until(() => !batch.names.includes(fast.name!));
      assert.deepEqual(batch.names, [slow.name], "real execution onResult must release only the finished name");
      assert.equal(batchDone, false);
      assert.equal(
        Array.from(f.state.activeSubagents.values()).some((worker) => worker.name === fast.name),
        false,
      );
      const allowance = readBudget(f.state.currentBudget!);
      const result = await f.execute({ name: fast.name, message: "resume" }, AbortSignal.timeout(2000));
      assertSuccess(result);
      assert.match(text(result), /started.*background/);
      assert.equal(batchDone, false, "resuming a finished worker must not wait for its sibling");
      assert.equal(f.state.backgroundJobs.get("siblings"), batch);
      assert.deepEqual(batch.names, [slow.name]);
      const resumed = Array.from(f.state.backgroundJobs.values()).find(
        (job) => job !== batch && job.names.includes(fast.name!),
      );
      assert.ok(resumed);
      await until(() => runner.runs().length === 3);
      const run = runner.runs()[2];
      assert.equal(run.prompt, "resume");
      assert.equal(run.args[run.args.indexOf("--session") + 1], path.join(fast.sessionDir!, "session.jsonl"));
      assert.equal(run.budget, fast.budget!.directory);
      assert.deepEqual(readBudget(f.state.currentBudget!), allowance, "resume must not reserve another worker slot");
      runner.release("resume");
      await resumed.promise;
      assert.equal(batchDone, false);
      runner.release("slow");
      await batch.promise;
      assert.equal(f.state.backgroundJobs.size, 0);
    } finally {
      await f.close();
    }
  },
);

test("idle failures leave no guards and do not change budgets", async () => {
  const f = await fixture();
  try {
    const initial = readBudget(f.state.currentBudget!);
    assert.match(text(await f.execute({ name: "unknown", message: "hello" })), /Unknown subagent/);
    assert.match(
      text(await f.execute({ name: f.name, message: "unfunded", max_subagents_allowed: 30 })),
      /extra slots/,
    );
    assert.equal(readNamesRegistry(f.state.currentNamesFile).agents[f.name].activeResumes, undefined);
    fs.rmSync(path.join(f.sessionDir, "session.jsonl"));
    assert.match(
      text(await f.execute({ name: f.name, message: "hello", max_subagents_allowed: 4 })),
      /no saved session/,
    );
    assert.equal(f.state.activeResumeNames.size, 0);
    assert.equal(f.state.backgroundJobs.size, 0);
    assert.equal(readNamesRegistry(f.state.currentNamesFile).agents[f.name].activeResumes, undefined);
    assert.deepEqual(readBudget(f.state.currentBudget!), initial);
  } finally {
    await f.close();
  }
});
