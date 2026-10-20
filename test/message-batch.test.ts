import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { MessageSubagentParams } from "../extension/schemas.js";
import { fixture, gatedRunner, until, assertSuccess, sdk } from "./helpers/message-subagent.js";
import { readBudget } from "../budget.js";

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((part) => part.text ?? "").join("\n");

test("the strict provider schema accepts a nonempty recipient array, never blank or invalid names", () => {
  for (const name of [["Alice"], ["Alice", "Bob"]])
    assert.ok(Value.Check(MessageSubagentParams, { name, message: "hello" }));
  for (const name of [[], [""], [" "], ["Alice", 1], ["Alice", null], {}, null])
    assert.equal(Value.Check(MessageSubagentParams, { name, message: "hello" }), false);
});

test("one call steers several live workers concurrently with exactly the same private message", async () => {
  const f = await fixture();
  let release!: (accepted: boolean) => void;
  const gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  try {
    const deliveries: Array<{ name: string; message: string }> = [];
    f.running((message) => {
      deliveries.push({ name: f.name, message });
      return gate;
    });
    f.state.activeSubagents.set(2, {
      name: "Bob",
      agent: "",
      task: "work",
      handle: {
        steer(message) {
          deliveries.push({ name: "Bob", message });
          return true;
        },
      },
    });
    const message = "Update the shared API.\nKeep backward compatibility.";
    const response = f.execute({ name: [f.name, "Bob"], message });
    await until(() => deliveries.length === 2);
    assert.deepEqual(deliveries, [
      { name: f.name, message },
      { name: "Bob", message },
    ]);
    release(true);
    const result = await response;
    assertSuccess(result);
    assert.match(text(result), /Bob:/);
    assert.equal(f.state.forcedErrorToolCallIds.size, 0);
    assert.equal(f.state.backgroundJobs.size, 0);
  } finally {
    release(true);
    await f.close();
  }
});

test("duplicate recipients receive one copy and a failed recipient does not hide successful deliveries", async () => {
  const f = await fixture();
  try {
    const received: string[] = [];
    f.running((message) => {
      received.push(message);
      return true;
    });
    const result = await f.execute({ name: [f.name, f.name, "UnknownPerson"], message: "same message" });
    assert.deepEqual(received, ["same message"]);
    assert.equal(Reflect.get(result, "isError"), true);
    assert.match(text(result), /Unknown subagent/);
    assert.match(text(result), /Message sent/);
    assert.equal(
      f.state.forcedErrorToolCallIds.size,
      1,
      "retain only the model-visible tool error, not per-recipient ids",
    );
  } finally {
    await f.close();
  }
});

test(
  "a mixed live/idle batch resumes idle sessions using only the message and returns before completion",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const runner = gatedRunner(f);
      const received: string[] = [];
      f.state.activeSubagents.set(2, {
        name: "Bob",
        agent: "",
        task: "work",
        handle: {
          steer(message) {
            received.push(message);
            return true;
          },
        },
      });
      const message = "Same follow-up\nSecond line";
      const before = readBudget(f.state.currentBudget!).remaining;
      const result = await f.execute({ name: [f.name, "Bob"], message });
      assertSuccess(result);
      assert.deepEqual(received, [message]);
      await until(() => runner.runs().length === 1);
      assert.equal(runner.runs()[0].prompt, message);
      assert.equal(f.state.backgroundJobs.size, 1);
      assert.equal(readBudget(f.state.currentBudget!).remaining, before, "resuming consumes no fresh worker slot");
      assert.match(text(result), /started in the background/);
    } finally {
      await f.close();
    }
  },
);

test("batch optional null allowance remains omission and invalid arrays send nothing", async () => {
  const f = await fixture();
  try {
    const received: string[] = [];
    f.running((message) => {
      received.push(message);
      return true;
    });
    const args = sdk(f.tool, { name: [f.name], message: "hello", max_subagents_allowed: null });
    assertSuccess(await f.execute(args));
    assert.deepEqual(received, ["hello"]);
    assert.equal(Reflect.get(await f.execute({ name: [f.name, ""], message: "bad" }), "isError"), true);
    assert.deepEqual(received, ["hello"]);
  } finally {
    await f.close();
  }
});
