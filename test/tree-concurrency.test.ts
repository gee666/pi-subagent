import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  createTreeConcurrencyStore,
  matchesProcess,
  type TreeConcurrencyEntry,
  type TreeConcurrencyStore,
} from "../storage/tree-concurrency.js";
import { processIdentity } from "../storage/tree-concurrency-process.js";

const moduleUrl = new URL("../storage/tree-concurrency.ts", import.meta.url).href;
const program = `
  import { createTreeConcurrencyStore } from ${JSON.stringify(moduleUrl)};
  const store = createTreeConcurrencyStore({limit:999});
  process.on('message', ({id, method, args}) => {
    try { process.send({id, result: store[method](...args)}); }
    catch(error) { process.send({id, error: String(error)}); }
  });
  process.send({ready:true});
`;
interface Peer {
  child: ChildProcess;
  call<T = any>(method: string, ...args: unknown[]): Promise<T>;
  close(): Promise<void>;
}
async function peer(store: TreeConcurrencyStore): Promise<Peer> {
  const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", program], {
    cwd: process.cwd(),
    env: { ...process.env, PI_SUBAGENT_CONCURRENCY_DIR: store.directory },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  let next = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (message: any) => {
      if (message.ready) return resolve();
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error));
      else request?.resolve(message.result);
    });
    child.on("error", reject);
    child.on("exit", () => {
      const error = new Error(`Peer exited: ${stderr}`);
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    });
  });
  await ready;
  return {
    child,
    call(method, ...args) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        child.send({ id, method, args });
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    },
  };
}
async function fixture(limit: number) {
  const temporaryRoot = path.resolve("tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, "tree-concurrency-test-"));
  const store = createTreeConcurrencyStore({ directory: path.join(root, "ledger"), limit });
  const peers: Peer[] = [];
  return {
    store,
    root,
    async peer() {
      const result = await peer(store);
      peers.push(result);
      return result;
    },
    async close() {
      await Promise.all(peers.map((entry) => entry.close()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
async function start(p: Peer, name: string, parent?: string): Promise<string> {
  const token = await p.call<string>("enqueue", name, ...(parent ? [parent] : []));
  assert.equal(await p.call("claim", token), "running");
  await p.call("bindPid", token, p.child.pid);
  return token;
}

// These tests use independent Node/tsx processes, not multiple handles in one process.
test(
  "global cap counts parking parent until exit; root work and children outrank its wake",
  { timeout: 15000 },
  async () => {
    const f = await fixture(1);
    try {
      const parent = await f.peer(),
        nested = await f.peer();
      const token = await start(parent, "parent");
      f.store.adopt(token);
      const child = f.store.enqueue("child", token);
      const root = f.store.enqueue("root sibling");
      assert.equal(await nested.call("claim", child), "queued");
      await parent.call("release", token);
      assert.equal(f.store.get(token)?.status, "running", "live PID cannot release its slot");
      await parent.call("markWaiting", token, true);
      assert.equal(f.store.get(token)?.status, "parking");
      assert.equal(await nested.call("claim", child), "queued");
      assert.equal(f.store.claim(root), "queued");
      assert.equal(f.store.snapshot().filter((entry) => entry.status === "parking").length, 1);
      await parent.close();
      f.store.release(token);
      assert.equal(f.store.get(token)?.status, "suspended");
      assert.equal(f.store.requestWake(token), true);
      assert.equal(f.store.claim(token), "queued");
      assert.equal(await nested.call("claim", child), "running");
      await nested.call("bindPid", child, nested.child.pid);
      assert.equal(f.store.claim(root), "queued");
      await nested.close();
      assert.equal(f.store.claim(token), "queued");
      assert.equal(f.store.claim(root), "running");
      f.store.release(root);
      assert.equal(f.store.claim(token), "running");
    } finally {
      await f.close();
    }
  },
);

test("simultaneous independent owners obey committed FIFO and never overcommit", { timeout: 20000 }, async () => {
  const f = await fixture(3);
  try {
    const owners = await Promise.all(Array.from({ length: 8 }, () => f.peer()));
    const tokens = await Promise.all(owners.map((p, i) => p.call<string>("enqueue", `worker-${i}`)));
    const order = f.store.snapshot().map((entry) => entry.token);
    const byToken = new Map(tokens.map((token, i) => [token, owners[i]]));
    for (let round = 0; round < 8; round++) {
      await Promise.all([...tokens].reverse().map((token) => byToken.get(token)!.call("claim", token)));
      const running = f.store.snapshot().filter((entry) => entry.status === "running");
      assert.ok(running.length <= 3);
      assert.deepEqual(
        running.map((entry) => entry.token),
        order.slice(0, running.length),
      );
    }
    assert.deepEqual(
      f.store
        .snapshot()
        .filter((entry) => entry.status === "running")
        .map((e) => e.token),
      order.slice(0, 3),
    );
    await Promise.all(
      order.slice(0, 3).map((token) => byToken.get(token)!.call("bindPid", token, byToken.get(token)!.child.pid)),
    );
    assert.equal(await owners[0].call("getLimit"), 3, "inherited limit 999 cannot override the root");
    await assert.rejects(owners[0].call("setLimit", 99), /Only the root/);
    f.store.setLimit(1);
    assert.equal(f.store.snapshot().filter((e) => e.status === "running").length, 3);
    assert.equal(await byToken.get(order[3])!.call("claim", order[3]), "queued");
    await byToken.get(order[0])!.close();
    await byToken.get(order[1])!.close();
    assert.equal(await byToken.get(order[3])!.call("claim", order[3]), "queued");
    await byToken.get(order[2])!.close();
    assert.equal(await byToken.get(order[4])!.call("claim", order[4]), "queued");
    assert.equal(await byToken.get(order[3])!.call("claim", order[3]), "running");
    f.store.setLimit(2);
    assert.equal(await byToken.get(order[5])!.call("claim", order[5]), "queued");
    assert.equal(await byToken.get(order[4])!.call("claim", order[4]), "running");
    assert.equal(f.store.snapshot().filter((e) => e.status === "running").length, 2);
  } finally {
    await f.close();
  }
});

test(
  "subtree stop tombstones queued/startup descendants before kill and preserves reservations",
  { timeout: 10000 },
  async () => {
    const f = await fixture(2);
    try {
      const worker = await f.peer();
      const parent = f.store.enqueue("parent");
      assert.equal(f.store.claim(parent), "running");
      const child = f.store.enqueue("startup", parent);
      assert.equal(f.store.claim(child), "running");
      const queued = f.store.enqueue("queued grandchild", child);
      const root = f.store.enqueue("unrelated");
      const stopped = f.store.stopSubtree("parent");
      assert.deepEqual(
        stopped.map((e) => [e.name, e.status]),
        [
          ["parent", "stopping"],
          ["startup", "stopping"],
          ["queued grandchild", "canceled"],
        ],
      );
      assert.equal(f.store.claim(queued), "canceled");
      assert.equal(f.store.claim(root), "queued", "unbound stopping workers retain both slots");
      f.store.bindPid(parent, worker.child.pid!);
      const lateRemote = await worker.call<string>("enqueue", "late remote child", parent);
      assert.equal(await worker.call("claim", lateRemote), "canceled");
      assert.equal(f.store.get(parent)?.status, "stopping", "bind after stop records the process instead of throwing");
      assert.equal(f.store.isProcessAlive(f.store.get(parent)!), true);
      f.store.release(parent);
      assert.equal(f.store.claim(root), "queued");
      for (const ancestor of [parent, child, queued]) {
        assert.equal(f.store.claim(f.store.enqueue("too late", ancestor)), "canceled");
      }
      f.store.release(child); // Owner confirms no process was spawned.
      assert.equal(f.store.claim(root), "running");
      assert.ok(f.store.stopSubtree(parent).some((e) => e.pid === worker.child.pid));
      await worker.close();
      f.store.release(parent);
      assert.equal(f.store.get(parent)?.status, "released");
      f.store.release(root);
    } finally {
      await f.close();
    }
  },
);

test(
  "dead queued owners cancel; live bound children retain capacity after their owner dies",
  { timeout: 10000 },
  async () => {
    const f = await fixture(1);
    try {
      const owner = await f.peer(),
        survivor = await f.peer();
      const queued = await owner.call<string>("enqueue", "orphan queued");
      const running = await owner.call<string>("enqueue", "orphan running");
      assert.equal(await owner.call("claim", queued), "running");
      await owner.call("release", queued);
      assert.equal(await owner.call("claim", running), "running");
      await owner.call("bindPid", running, survivor.child.pid);
      const abandoned = await owner.call<string>("enqueue", "abandoned queue");
      const root = f.store.enqueue("root");
      await owner.close();
      assert.equal(f.store.get(abandoned)?.status, "canceled");
      assert.equal(f.store.get(running)?.status, "running");
      f.store.release(running);
      assert.equal(f.store.claim(root), "queued");
      await survivor.close();
      assert.equal(f.store.claim(root), "running");
      assert.equal(f.store.get(running)?.status, "released");
      f.store.release(root);
    } finally {
      await f.close();
    }
  },
);

test(
  "owner crash before bind stays fail closed; another process cannot acknowledge abort",
  { timeout: 10000 },
  async () => {
    const f = await fixture(1);
    try {
      const owner = await f.peer();
      const token = await owner.call<string>("enqueue", "spawn window");
      assert.equal(await owner.call("claim", token), "running");
      await owner.close();
      const root = f.store.enqueue("root");
      assert.equal(f.store.get(token)?.status, "stopping");
      assert.match(f.store.get(token)!.reason!, /reservation retained for safety/);
      assert.equal(f.store.claim(root), "queued");
      assert.throws(() => f.store.release(token), /Only the reservation owner/);
      const lateChild = await f.peer();
      await lateChild.call("bindPid", token, lateChild.child.pid);
      assert.equal(f.store.get(token)?.pid, lateChild.child.pid);
      assert.equal(f.store.claim(root), "queued");
      await lateChild.close();
      assert.equal(f.store.claim(root), "running");
    } finally {
      await f.close();
    }
  },
);

test("PID identity mismatches are dead; corrupt state cannot reset the root cap", async () => {
  const f = await fixture(2);
  try {
    const identity = processIdentity(process.pid);
    assert.equal(matchesProcess(process.pid, identity.startTime), true);
    assert.equal(matchesProcess(-1), false);
    if (identity.startTime) assert.equal(matchesProcess(process.pid, `${identity.startTime}-other`), false);
    const token = f.store.enqueue("first");
    assert.equal(f.store.claim(token), "running");
    const revisions = fs.readdirSync(f.store.directory).filter((name) => /^state-\d+\.json$/.test(name));
    const latest = revisions.sort((a, b) => Number(a.slice(6, -5)) - Number(b.slice(6, -5))).at(-1)!;
    fs.writeFileSync(path.join(f.store.directory, latest), "{broken");
    assert.throws(() => f.store.snapshot(), /launches blocked/);
    assert.throws(() => f.store.claim(token), /launches blocked/);
    assert.throws(() => createTreeConcurrencyStore({ directory: f.store.directory, limit: 99 }), /launches blocked/);
    assert.throws(() => createTreeConcurrencyStore({ directory: f.root, limit: 99 }), /launches blocked/);
  } finally {
    await f.close();
  }
});

test(
  "only root-owned durable descendants permit safe idle parking; suspended ancestry stays open",
  { timeout: 10000 },
  async () => {
    const f = await fixture(2);
    try {
      const a = await f.peer(),
        b = await f.peer();
      const parent = await start(a, "a");
      const other = await start(b, "b");
      const child = await a.call<string>("enqueue", "child", parent);
      await a.call("markWaiting", parent, true);
      assert.equal(f.store.get(parent)?.status, "running", "unbrokered closures cannot survive parent exit");
      await assert.rejects(a.call("adopt", child), /Only the root/);
      f.store.adopt(parent);
      f.store.adopt(child);
      assert.equal(f.store.get(parent)?.status, "parking");
      await a.close();
      assert.equal(f.store.get(parent)?.status, "suspended");
      const late = f.store.enqueue("late", parent);
      assert.equal(f.store.get(late)?.status, "queued");
      assert.equal(f.store.claim(child), "running");
      const entries: TreeConcurrencyEntry[] = f.store.snapshot();
      assert.equal(entries.find((e) => e.token === other)?.status, "running");
    } finally {
      await f.close();
    }
  },
);
