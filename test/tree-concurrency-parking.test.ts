import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createTreeConcurrencyStore } from "../storage/tree-concurrency.js";

async function fixture(limit: number) {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/tree-concurrency-parking-"));
  const store = createTreeConcurrencyStore({ directory: path.join(root, "ledger"), limit });
  const processes: Array<{ pid: number; close(): Promise<void> }> = [];
  async function workerProcess() {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const worker = {
      pid: child.pid!,
      async close() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      },
    };
    processes.push(worker);
    return worker;
  }
  return {
    store,
    workerProcess,
    async bind(token: string) {
      const worker = await workerProcess();
      store.bindPid(token, worker.pid);
      return worker;
    },
    async start(name: string, parentToken?: string) {
      const token = store.enqueue(name, parentToken);
      assert.equal(store.claim(token), "running");
      const worker = await workerProcess();
      store.bindPid(token, worker.pid);
      return { ...worker, token };
    },
    async close() {
      await Promise.all(processes.map((worker) => worker.close()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  "active model work never parks; an idle park request cannot lend its live PID slot",
  { timeout: 10000 },
  async () => {
    const f = await fixture(1);
    try {
      const parent = await f.start("parent");
      const child = f.store.enqueue("child", parent.token);
      assert.equal(f.store.getRootPid(), process.pid);
      assert.equal(f.store.requestPark(parent.token), false);
      assert.equal(f.store.get(parent.token)?.status, "running");
      f.store.markWaiting(parent.token, true);
      assert.equal(f.store.get(parent.token)?.status, "parking");
      assert.equal(f.store.requestWake(parent.token), false);
      f.store.release(parent.token, parent.pid);
      assert.equal(f.store.claim(child), "queued");
      f.store.markWaiting(parent.token, false);
      assert.equal(f.store.get(parent.token)?.status, "running", "new model activity withdraws a pending park");
      f.store.markWaiting(parent.token, true);
      await parent.close();
      f.store.release(parent.token, parent.pid);
      assert.equal(f.store.get(parent.token)?.status, "suspended");
      assert.equal(f.store.get(parent.token)?.pid, undefined);
      assert.equal(f.store.claim(child), "running");
      assert.equal(
        f.store.snapshot().some((entry) => entry.status === "rejected"),
        false,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "stable parent tokens rebind only after death and fresh admission; stale exit callbacks cannot free the wake",
  { timeout: 10000 },
  async () => {
    const f = await fixture(1);
    try {
      const parent = await f.start("parent");
      const child = f.store.enqueue("child", parent.token);
      f.store.markWaiting(parent.token, true);
      assert.throws(() => f.store.bindPid(parent.token, process.pid), /live worker PID/);
      await parent.close();
      f.store.release(parent.token, parent.pid);
      assert.equal(f.store.get(parent.token)?.status, "suspended");
      assert.throws(() => f.store.bindPid(parent.token, process.pid), /running reservation/);
      assert.equal(f.store.requestWake(parent.token), true);
      assert.equal(f.store.get(parent.token)?.status, "waking");
      assert.throws(() => f.store.bindPid(parent.token, process.pid), /running reservation/);
      assert.equal(f.store.claim(child), "running");
      f.store.release(child);
      assert.equal(f.store.claim(parent.token), "running");
      f.store.release(parent.token, parent.pid);
      assert.equal(f.store.get(parent.token)?.status, "running", "old exit cannot clear unbound wake admission");
      const resumed = await f.workerProcess();
      f.store.bindPid(parent.token, resumed.pid);
      f.store.release(parent.token, parent.pid);
      assert.equal(f.store.get(parent.token)?.pid, resumed.pid);
      assert.equal(f.store.get(child)?.parentToken, parent.token);
      assert.equal(f.store.snapshot().filter((entry) => entry.name === "parent").length, 1);
      await resumed.close();
      f.store.release(parent.token, resumed.pid);
      assert.equal(f.store.get(parent.token)?.status, "released");
    } finally {
      await f.close();
    }
  },
);

test(
  "ordinary work outranks waking FIFO; spare capacity permits early resume while a child still runs",
  { timeout: 10000 },
  async () => {
    const f = await fixture(2);
    try {
      const a = await f.start("a"),
        b = await f.start("b");
      const childA = f.store.enqueue("a child", a.token),
        childB = f.store.enqueue("b child", b.token);
      f.store.markWaiting(a.token, true);
      f.store.markWaiting(b.token, true);
      await Promise.all([a.close(), b.close()]);
      assert.equal(f.store.requestWake(b.token), true);
      const order = f.store.get(b.token)?.wakeOrder;
      assert.equal(f.store.requestWake(a.token), true);
      assert.equal(f.store.requestWake(b.token), true);
      assert.equal(f.store.get(b.token)?.wakeOrder, order, "duplicate wake does not reorder FIFO");
      const newlyQueued = f.store.enqueue("new child after wake request", a.token);
      assert.equal(f.store.claim(a.token), "queued");
      assert.equal(f.store.claim(b.token), "queued");
      assert.equal(f.store.claim(childA), "running");
      assert.equal(f.store.claim(childB), "running");
      f.store.release(childB);
      assert.equal(f.store.claim(b.token), "queued", "ordinary work added after wake still has priority");
      assert.equal(f.store.claim(newlyQueued), "running");
      f.store.release(newlyQueued);
      assert.equal(f.store.claim(a.token), "queued", "wake order is request order, not original token order");
      assert.equal(f.store.claim(b.token), "running", "one child may still occupy the other slot");
      assert.equal(f.store.get(b.token)?.waitingForChildren, false, "resumed parent starts active");
      assert.equal(f.store.get(childA)?.status, "running");
      f.store.release(childA);
      assert.equal(f.store.claim(a.token), "running");
      assert.equal(f.store.snapshot().filter((entry) => entry.status === "running").length, 2);
    } finally {
      await f.close();
    }
  },
);

for (const wake of [false, true]) {
  test(
    `subtree stop tombstones ${wake ? "waking" : "suspended"} parents and queued descendants`,
    { timeout: 10000 },
    async () => {
      const f = await fixture(1);
      try {
        const parent = await f.start("parent");
        const child = f.store.enqueue("child", parent.token);
        f.store.markWaiting(parent.token, true);
        await parent.close();
        assert.equal(f.store.get(parent.token)?.status, "suspended");
        if (wake) f.store.requestWake(parent.token);
        const rows = f.store.stopSubtree(parent.token);
        assert.deepEqual(
          rows.map((entry) => entry.status),
          ["canceled", "canceled"],
        );
        assert.equal(f.store.requestWake(parent.token), false);
        assert.equal(f.store.claim(child), "canceled");
        assert.equal(f.store.claim(f.store.enqueue("late", parent.token)), "canceled");
        assert.equal(f.store.claim(f.store.enqueue("unrelated")), "running");
      } finally {
        await f.close();
      }
    },
  );
}

test(
  "spare capacity never requests parking; mixed unbrokered descendants block parent unload",
  { timeout: 10000 },
  async () => {
    const f = await fixture(3);
    try {
      const parent = await f.start("parent");
      const localWorker = await f.workerProcess();
      const local = f.store.enqueue("unbrokered active child", parent.token, localWorker.pid);
      assert.equal(f.store.claim(local), "running");
      f.store.bindPid(local, localWorker.pid);
      const queued = f.store.enqueue("broker-owned child", parent.token);
      f.store.markWaiting(parent.token, true);
      assert.equal(f.store.get(parent.token)?.status, "running", "capacity is available");
      f.store.setLimit(2);
      assert.equal(f.store.get(parent.token)?.status, "running", "one root-owned job is insufficient for safe handoff");
      f.store.adopt(local);
      assert.equal(f.store.get(parent.token)?.status, "parking");
      assert.equal(f.store.claim(queued), "queued");
      f.store.stopSubtree(parent.token);
      assert.equal(f.store.get(parent.token)?.status, "stopping");
      await parent.close();
      assert.equal(f.store.get(parent.token)?.status, "released", "stop during park is terminal, never suspended");
      assert.equal(f.store.requestWake(parent.token), false);
    } finally {
      await f.close();
    }
  },
);

test("cap one A -> B -> C wakes B before its earlier-queued ancestor A", { timeout: 10000 }, async () => {
  const f = await fixture(1);
  try {
    const a = await f.start("A");
    const b = f.store.enqueue("B", a.token);
    f.store.markWaiting(a.token, true);
    assert.equal(f.store.get(a.token)?.status, "parking");
    await a.close();
    assert.equal(f.store.requestWake(a.token), true);
    const aWakeOrder = f.store.get(a.token)!.wakeOrder!;
    assert.equal(f.store.claim(b), "running");
    const bWorker = await f.bind(b);
    const c = f.store.enqueue("C", b);
    f.store.markWaiting(b, true);
    assert.equal(f.store.get(b)?.status, "parking");
    await bWorker.close();
    assert.equal(f.store.requestWake(b), true);
    assert.ok(f.store.get(b)!.wakeOrder! > aWakeOrder, "ancestor entered wake FIFO first");
    assert.equal(f.store.claim(c), "running");
    f.store.release(c);
    assert.equal(f.store.claim(a.token), "queued", "old ancestor cannot block its child's continuation");
    assert.equal(f.store.claim(b), "running");
    const resumedB = await f.bind(b);
    assert.equal(f.store.claim(a.token), "queued", "the live child still owns the only slot");
    await resumedB.close();
    f.store.release(b, resumedB.pid);
    assert.equal(f.store.claim(a.token), "running");
  } finally {
    await f.close();
  }
});

test(
  "limit drop lets an idle ancestor yield to a waking child; raising the cap permits early parent resume",
  { timeout: 10000 },
  async () => {
    const f = await fixture(2);
    try {
      const a = await f.start("A"),
        b = await f.start("B", a.token);
      const c = f.store.enqueue("C", b.token);
      f.store.markWaiting(b.token, true);
      assert.equal(f.store.get(b.token)?.status, "parking");
      f.store.setLimit(1);
      assert.equal(f.store.claim(c), "queued", "lowering the cap never borrows a still-live parking slot");
      assert.equal(f.store.snapshot().filter((entry) => f.store.isProcessAlive(entry)).length, 2);
      await b.close();
      assert.equal(f.store.requestWake(b.token), true);
      f.store.setLimit(2);
      assert.equal(f.store.claim(c), "running");
      f.store.release(c);
      f.store.setLimit(1);
      assert.equal(f.store.claim(b.token), "queued");
      assert.equal(f.store.get(a.token)?.status, "running", "active model work is not parked");
      f.store.markWaiting(a.token, true);
      assert.equal(f.store.get(a.token)?.status, "parking", "a waking descendant is runnable work too");
      assert.equal(f.store.claim(b.token), "queued", "parking ancestor keeps its slot until PID exit");
      await a.close();
      f.store.requestWake(a.token);
      assert.equal(f.store.claim(b.token), "running");
      const resumedB = await f.bind(b.token);
      assert.equal(f.store.claim(a.token), "queued");
      f.store.setLimit(2);
      assert.equal(f.store.claim(a.token), "running", "spare capacity may resume a parent before its child finishes");
      await f.bind(a.token);
      const live = f.store.snapshot().filter((entry) => f.store.isProcessAlive(entry));
      assert.equal(live.length, 2);
      assert.ok(live.some((entry) => entry.pid === resumedB.pid));
    } finally {
      await f.close();
    }
  },
);
