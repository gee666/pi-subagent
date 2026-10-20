import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { WorkerScheduler } from "../runner/worker-scheduler.js";
import { createTreeConcurrencyStore } from "../storage/tree-concurrency.js";
import { settingsFixture } from "./helpers/settings.js";

test("detaching a parent's broker watch cannot release an acknowledged queued child", async () => {
  const f = settingsFixture();
  const store = createTreeConcurrencyStore({ directory: path.join(f.root, "tree"), limit: 2 });
  const parent = store.enqueue("Parent");
  assert.equal(store.claim(parent), "running");
  store.bindPid(parent, process.pid);
  const scheduler = new WorkerScheduler(2, {
    store,
    parentToken: parent,
    brokerEndpoint: { directory: path.join(f.root, "broker"), secret: "test" },
  });
  try {
    let detach!: (error: Error) => void;
    const watch = new Promise<void>((_resolve, reject) => {
      detach = reject;
    });
    const ticket = scheduler.scheduleRemote("Child", () => watch);
    const child = store.snapshot().find((entry) => entry.name === "Child")!;
    assert.equal(child.status, "queued");
    detach(new Error("parent watcher detached for parking"));
    await assert.rejects(ticket.promise, /detached/);
    assert.equal(store.get(child.token)?.status, "queued", "the root broker retains the queued job");
    store.adopt(child.token);
    assert.equal(store.claim(child.token), "running", "the same child can still start without re-submission");
    store.release(child.token);
  } finally {
    scheduler.shutdown();
    f.close();
  }
});
