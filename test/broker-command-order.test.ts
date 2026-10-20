import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHmac } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { test } from "node:test";
import { processBrokerCommands, sendBrokerLead, steerBrokerJob } from "../broker/commands.js";
import { writeExclusive } from "../broker/files.js";
import type { RunningSubagentHandle } from "../runner/options.js";
import { createTreeConcurrencyStore } from "../storage/tree-concurrency.js";
import { processIdentity } from "../storage/tree-concurrency-process.js";

function fixture() {
  const temporary = path.resolve("tmp");
  fs.mkdirSync(temporary, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporary, "broker-order-"));
  const store = createTreeConcurrencyStore({ directory: path.join(root, "ledger"), limit: 10 });
  const endpoint = { directory: path.join(root, "broker"), secret: "order-test-secret" };
  writeExclusive(path.join(endpoint.directory, "manifest.json"), {
    version: 1,
    rootPid: process.pid,
    rootStartTime: processIdentity(process.pid).startTime,
    concurrencyDirectory: store.directory,
  });
  fs.writeFileSync(path.join(endpoint.directory, "secret"), endpoint.secret);
  const owner = store.enqueue("owner");
  assert.equal(store.claim(owner), "running");
  const target = store.enqueue("target", owner);
  const handles = new Map<string, RunningSubagentHandle>();
  const poll = () => processBrokerCommands(endpoint, store, handles);
  const log = () => fs.readFileSync(path.join(endpoint.directory, "command-order"), "utf8");
  const ids = () => log().split("\n").filter(Boolean);
  const result = (id: string) =>
    JSON.parse(fs.readFileSync(path.join(endpoint.directory, "command-results", `${id}.json`), "utf8"));
  const command = (id: string, fields: object) => {
    const request = { id, ownerToken: owner, targetToken: target, ...fields };
    const mac = createHmac("sha256", endpoint.secret).update(JSON.stringify(request)).digest("hex");
    writeExclusive(path.join(endpoint.directory, "commands", `${id}.json`), { request, mac });
    writeExclusive(path.join(endpoint.directory, "command-ready", `${id}.json`), { id });
  };
  return {
    root,
    store,
    endpoint,
    owner,
    target,
    handles,
    poll,
    log,
    ids,
    result,
    command,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("sequential queued acknowledgments survive reopening and deliver 111 then 222", async () => {
  const f = fixture();
  try {
    assert.equal(await steerBrokerJob(f.endpoint, f.owner, f.target, "PARK-A-111"), true);
    assert.equal(await steerBrokerJob(f.endpoint, f.owner, f.target, "PARK-A-222"), true);
    f.poll();
    assert.equal(fs.existsSync(path.join(f.endpoint.directory, "command-results")), false);
    const received: string[] = [];
    // A fresh handle map has no submission-time memory to supply the order.
    const handles = new Map<string, RunningSubagentHandle>([
      [
        f.target,
        {
          steer: (message) => {
            received.push(message);
            return true;
          },
        },
      ],
    ]);
    assert.equal(f.store.claim(f.target), "running");
    const poll = () => processBrokerCommands(f.endpoint, f.store, handles);
    poll();
    await tick();
    assert.deepEqual(received, ["PARK-A-111"]);
    poll();
    await tick();
    assert.deepEqual(received, ["PARK-A-111", "PARK-A-222"]);
    assert.deepEqual(f.ids().map(f.result), [{ accepted: true }, { accepted: true }]);
  } finally {
    f.close();
  }
});

test("slow first ACK blocks siblings across polls but not another target", async () => {
  const f = fixture();
  let accept!: (accepted: boolean) => void;
  try {
    const other = f.store.enqueue("other", f.owner);
    await steerBrokerJob(f.endpoint, f.owner, f.target, "111");
    await steerBrokerJob(f.endpoint, f.owner, f.target, "222");
    await steerBrokerJob(f.endpoint, f.owner, other, "other");
    const received: string[] = [];
    f.handles.set(f.target, {
      steer: async (message) => {
        if (message === "111")
          await new Promise<boolean>((resolve) => {
            accept = resolve;
          });
        received.push(message);
        return true;
      },
    });
    f.handles.set(other, {
      steer: (message) => {
        received.push(message);
        return true;
      },
    });
    f.poll();
    await tick();
    f.poll();
    await tick();
    assert.deepEqual(received, ["other"]);
    accept(true);
    await tick();
    f.poll();
    await tick();
    assert.deepEqual(received, ["other", "111", "222"]);
  } finally {
    accept?.(true);
    await tick();
    f.close();
  }
});

test("log order beats hash filenames, excludes uncommitted requests and recovers a torn tail", async () => {
  const f = fixture();
  try {
    const first = "f".repeat(64),
      second = "0".repeat(64),
      uncommitted = "1".repeat(64);
    f.command(first, { ordered: true, message: "111" });
    f.command(second, { ordered: true, message: "222" });
    f.command(uncommitted, { ordered: true, message: "not committed" });
    fs.writeFileSync(path.join(f.endpoint.directory, "command-order"), `\n${first}\n\n${second}\n\ndeadbeef`);
    // The public submitter must separate its record from an interrupted append.
    await steerBrokerJob(f.endpoint, f.owner, f.target, "333");
    const received: string[] = [];
    f.handles.set(f.target, {
      steer: (message) => {
        received.push(message);
        return true;
      },
    });
    for (let i = 0; i < 4; i++) {
      f.poll();
      await tick();
    }
    assert.deepEqual(received, ["111", "222", "333"]);
    fs.appendFileSync(path.join(f.endpoint.directory, "command-order"), `\n${uncommitted}`);
    f.poll();
    await tick();
    assert.deepEqual(received, ["111", "222", "333"]);
    fs.appendFileSync(path.join(f.endpoint.directory, "command-order"), "\n");
    f.poll();
    await tick();
    assert.deepEqual(received, ["111", "222", "333", "not committed"]);
  } finally {
    f.close();
  }
});

test("legacy commands use stable mtime order before logged requests", async () => {
  const f = fixture();
  try {
    const first = "f".repeat(64),
      second = "0".repeat(64);
    f.command(first, { message: "legacy 111" });
    f.command(second, { message: "legacy 222" });
    fs.utimesSync(path.join(f.endpoint.directory, "command-ready", `${first}.json`), 1, 1);
    fs.utimesSync(path.join(f.endpoint.directory, "command-ready", `${second}.json`), 2, 2);
    await steerBrokerJob(f.endpoint, f.owner, f.target, "new");
    const received: string[] = [];
    f.handles.set(f.target, {
      steer: (message) => {
        received.push(message);
        return true;
      },
    });
    for (let i = 0; i < 3; i++) {
      f.poll();
      await tick();
    }
    assert.deepEqual(received, ["legacy 111", "legacy 222", "new"]);
  } finally {
    f.close();
  }
});

test("lead shares target ordering and canceled first sender cannot block later commands or overwrite rejection", async () => {
  const f = fixture();
  let accept!: (accepted: boolean) => void;
  let lead: Promise<boolean> | undefined;
  let steer: Promise<boolean> | undefined;
  try {
    assert.equal(f.store.claim(f.target), "running");
    const sender = f.store.enqueue("sender", f.target);
    assert.equal(f.store.claim(sender), "running");
    lead = sendBrokerLead(f.endpoint, sender, "lead 111");
    steer = steerBrokerJob(f.endpoint, f.owner, f.target, "steer 222");
    const received: string[] = [];
    f.handles.set(f.target, {
      steer: (message) => {
        received.push(message);
        return message.includes("lead 111")
          ? new Promise<boolean>((resolve) => {
              accept = resolve;
            })
          : true;
      },
    });
    f.poll();
    await tick();
    f.poll();
    await tick();
    assert.deepEqual(received, ["Message from subagent sender:\nlead 111"]);
    f.store.stopSubtree(sender);
    f.poll();
    await tick();
    assert.deepEqual(received, ["Message from subagent sender:\nlead 111", "steer 222"]);
    assert.equal(await lead, false);
    assert.equal(await steer, true);
    const before = fs.readFileSync(path.join(f.endpoint.directory, "command-results", `${f.ids()[0]}.json`), "utf8");
    accept(true);
    await tick();
    assert.equal(
      fs.readFileSync(path.join(f.endpoint.directory, "command-results", `${f.ids()[0]}.json`), "utf8"),
      before,
    );
  } finally {
    accept?.(false);
    await tick();
    f.close();
  }
});

test("stop between poll and delivery drops the scheduled message", async () => {
  const f = fixture();
  try {
    await steerBrokerJob(f.endpoint, f.owner, f.target, "111");
    f.handles.set(f.target, {
      steer: () => {
        assert.fail("stopped target received a message");
      },
    });
    f.poll();
    f.store.stopSubtree(f.target);
    await tick();
    assert.deepEqual(f.ids().map(f.result), [{ accepted: false }]);
  } finally {
    f.close();
  }
});

test("stopping a queued target drops all its messages", async () => {
  const f = fixture();
  try {
    await steerBrokerJob(f.endpoint, f.owner, f.target, "111");
    await steerBrokerJob(f.endpoint, f.owner, f.target, "222");
    f.store.stopSubtree(f.target);
    f.handles.set(f.target, {
      steer: () => {
        assert.fail("stopped target received a message");
      },
    });
    f.poll();
    await tick();
    assert.deepEqual(f.ids().map(f.result), [{ accepted: false }, { accepted: false }]);
  } finally {
    f.close();
  }
});
