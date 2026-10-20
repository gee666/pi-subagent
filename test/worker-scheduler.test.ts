import assert from "node:assert/strict";
import test from "node:test";
import { WorkerScheduler } from "../runner/worker-scheduler.js";
import { schedulerFor, shutdownScheduler } from "../extension/scheduler.js";
import { createExtensionState } from "../extension/state.js";
import { deferred, until } from "./helpers/message-subagent.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("one FIFO queue limits simultaneous batches and reacts to live limit changes", async () => {
  const scheduler = new WorkerScheduler(2);
  const gates = Array.from({ length: 6 }, deferred);
  const starts: number[] = [];
  let running = 0,
    maximum = 0;
  const submit = (index: number) =>
    scheduler.schedule(`worker-${index}`, async () => {
      starts.push(index);
      maximum = Math.max(maximum, ++running);
      try {
        await gates[index].promise;
      } finally {
        running--;
      }
    });
  const first = [0, 1, 2].map(submit);
  const second = [3, 4, 5].map(submit);
  assert.deepEqual(
    [...first, ...second].map((ticket) => ticket.status),
    ["started", "started", "queued", "queued", "queued", "queued"],
  );
  await tick();
  assert.deepEqual(starts, [0, 1]);
  scheduler.setLimit(1);
  gates[0].resolve();
  await first[0].promise;
  await tick();
  assert.deepEqual(starts, [0, 1], "lowering a cap neither kills running workers nor admits replacements too soon");
  gates[1].resolve();
  await first[1].promise;
  await tick();
  assert.deepEqual(starts, [0, 1, 2]);
  scheduler.setLimit(3);
  await tick();
  assert.deepEqual(starts, [0, 1, 2, 3, 4]);
  assert.equal(maximum, 3);
  for (const gate of gates) gate.resolve();
  await Promise.all([...first, ...second].map((ticket) => ticket.promise));
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(scheduler.snapshot(), []);
});

test("queued abort removes just that worker and a running stop retains its slot until exit", async () => {
  const scheduler = new WorkerScheduler(1);
  const runningGate = deferred(),
    siblingGate = deferred();
  let kills = 0,
    canceledStarts = 0;
  const active = scheduler.schedule("active", () => runningGate.promise, {
    onCancel: () => {
      kills++;
    },
  });
  const source = new AbortController();
  const removed = scheduler.schedule(
    "removed",
    async () => {
      canceledStarts++;
    },
    { signal: source.signal },
  );
  const sibling = scheduler.schedule("sibling", () => siblingGate.promise);
  await tick();
  source.abort();
  await assert.rejects(removed.promise);
  assert.deepEqual(scheduler.snapshot(), [
    { name: "active", status: "started" },
    { name: "sibling", status: "queued" },
  ]);
  assert.equal(scheduler.stop("active"), "started");
  assert.equal(kills, 1);
  assert.equal(active.controller.signal.aborted, true);
  assert.equal(sibling.controller.signal.aborted, false);
  assert.equal(sibling.status, "queued");
  runningGate.resolve();
  await active.promise;
  await tick();
  assert.equal(sibling.status, "started");
  siblingGate.resolve();
  await sibling.promise;
  assert.equal(canceledStarts, 0);
});

test("preparation is visible to stop before I/O and detached activation replaces the tool signal", async () => {
  const scheduler = new WorkerScheduler(1);
  const tool = new AbortController();
  const preparation = scheduler.prepare("resume", { signal: tool.signal });
  assert.deepEqual(scheduler.snapshot(), [{ name: "resume", status: "queued" }]);
  assert.equal(scheduler.stop("resume"), "queued");
  await assert.rejects(preparation.promise);
  assert.equal(preparation.controller.signal.aborted, true);
  const nextTool = new AbortController(),
    gate = deferred();
  const next = scheduler.prepare("resume", { signal: nextTool.signal });
  const activated = scheduler.schedule("resume", () => gate.promise);
  assert.equal(activated, next);
  nextTool.abort();
  assert.equal(activated.controller.signal.aborted, false);
  gate.resolve();
  await activated.promise;
});

test("queued steering waits for readiness and stopping discards it", async () => {
  const scheduler = new WorkerScheduler(1);
  const gate = deferred();
  const blocker = scheduler.schedule("blocker", () => gate.promise);
  const stopped = scheduler.schedule("stopped", async () => {
    assert.fail("canceled work started");
  });
  const delivered: string[] = [];
  const discarded = scheduler.message("stopped", "discard")!;
  assert.equal(discarded.status, "queued");
  scheduler.stop("stopped");
  scheduler.setSteer("stopped", (message) => {
    delivered.push(message);
  });
  await assert.rejects(discarded.promise);
  await assert.rejects(stopped.promise);
  const target = scheduler.schedule("target", async () => {
    scheduler.setSteer("target", (message) => {
      delivered.push(message);
      return true;
    });
    await tick();
  });
  const pending = scheduler.message("target", "hello")!;
  assert.equal(pending.status, "queued");
  gate.resolve();
  await blocker.promise;
  assert.equal(await pending.promise, true);
  await target.promise;
  assert.deepEqual(delivered, ["hello"]);
});

test("shutdown removes queued work and old scheduler cannot admit after lifecycle reset", async () => {
  const state = createExtensionState({ getFlag: () => undefined } as never);
  state.currentDepth = 0;
  state.currentSubagentSessionRoot = "tmp/scheduler-lifecycle";
  state.settings = { PI_SUBAGENT_MAX_CONCURRENCY: "1" };
  const scheduler = schedulerFor(state),
    gate = deferred();
  const first = scheduler.schedule("first", () => gate.promise);
  const queued = scheduler.schedule("queued", async () => {
    assert.fail("shutdown resurrected work");
  });
  await tick();
  shutdownScheduler(state);
  await assert.rejects(queued.promise);
  assert.throws(() => scheduler.schedule("late", async () => {}), /shut down/);
  assert.equal(first.controller.signal.aborted, true);
  const fresh = schedulerFor(state);
  assert.notEqual(fresh, scheduler);
  assert.equal(fresh.concurrency, 1);
  state.settings.PI_SUBAGENT_MAX_CONCURRENCY = "3";
  assert.equal(schedulerFor(state).concurrency, 3);
  gate.resolve();
  await first.promise;
  await until(() => scheduler.snapshot().length === 0);
});
