import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { schedulerFor } from "../extension/scheduler.js";
import { isSubagentDetails, SUBAGENT_COMPLETION_TYPE } from "../types.js";
import { fixture, gatedRunner, until, assertSuccess, text } from "./helpers/message-subagent.js";

for (const cancel of [false, true]) {
  test(`queued launch messages acknowledge before admission, cancel ${cancel}`, { timeout: 10000 }, async () => {
    const f = await fixture();
    const runner = gatedRunner(f, true);
    f.state.settings = { ...f.state.settings, PI_SUBAGENT_MAX_CONCURRENCY: "1" };
    Object.assign(f.ctx, { model: { provider: "original", id: "provider-model" } });
    // Acknowledge steering RPCs as the real child does, while keeping each task gated.
    const script = path.join(f.root, "fake-pi.cjs");
    fs.writeFileSync(
      script,
      fs
        .readFileSync(script, "utf8")
        .replace(
          'if (request.type !== "prompt") return;',
          'if (request.type !== "prompt") return; console.log(JSON.stringify({type:"response",command:"prompt",id:request.id,success:true}));',
        ),
    );
    const completions: string[] = [];
    f.state.pi.sendMessage = (message) => {
      if (message.customType === SUBAGENT_COMPLETION_TYPE && isSubagentDetails(message.details))
        completions.push(message.details.results[0].name!);
    };
    try {
      const launched = await f.launch({
        tasks: [
          { task: "first", max_subagents_allowed: 0 },
          { task: "second", max_subagents_allowed: 0 },
        ],
      });
      assertSuccess(launched);
      assert.ok(isSubagentDetails(launched.details));
      const [first, second] = launched.details.results;
      assert.ok(first.name && second.name);
      assert.deepEqual(
        Reflect.get(launched.details, "admissions").map((entry: { status: string }) => entry.status),
        ["started", "queued"],
      );
      assert.match(text(launched), /1 started, 1 queued/);
      assert.deepEqual(
        schedulerFor(f.state)
          .snapshot()
          .map((entry) => entry.name),
        [first.name, second.name],
      );
      const messaged = await f.execute({ name: second.name, message: "follow-up" }, AbortSignal.timeout(500));
      assertSuccess(messaged);
      assert.match(text(messaged), /Message queued/);
      assert.equal(Reflect.get(messaged.details!, "queued"), true);
      const later = await f.launch({ tasks: [{ task: "third", max_subagents_allowed: 0 }] }, "later");
      assertSuccess(later);
      assert.match(text(later), /0 started, 1 queued/);
      await until(() => runner.runs().length === 1);
      if (cancel) assert.equal(schedulerFor(f.state).stop(second.name), "queued");
      runner.release("first");
      if (!cancel) {
        await until(() => runner.runs().some((run) => run.prompt === "follow-up"));
        assert.match(runner.runs()[1].prompt, /^second/);
        runner.release("second");
        runner.release("follow-up");
      }
      await until(() => runner.runs().some((run) => run.prompt.startsWith("third")));
      assert.equal(
        schedulerFor(f.state)
          .snapshot()
          .filter((entry) => entry.status === "started").length,
        1,
      );
      runner.release("third");
      await until(() => f.state.backgroundJobs.size === 0 && completions.length === 3);
      assert.equal(
        completions.filter((name) => name === second.name).length,
        1,
        "queued cancellation publishes exactly one completion",
      );
      if (cancel) {
        assert.equal(runner.runs().length, 2);
        assert.ok(!runner.runs().some((run) => run.prompt === "follow-up"));
      }
    } finally {
      for (const name of ["first", "second", "third", "follow-up"]) runner.release(name);
      await f.close();
    }
  });
}

test("oversized message arrays fail before steering anyone", async () => {
  const f = await fixture();
  try {
    f.state.maxTasksPerCall = 1;
    let messages = 0;
    f.running(() => {
      messages++;
    });
    const result = await f.execute({ name: [f.name, "other"], message: "hello" });
    assert.equal(Reflect.get(result, "isError"), true);
    assert.match(text(result), /Max tasks per call is 1/);
    assert.equal(messages, 0);
  } finally {
    await f.close();
  }
});
