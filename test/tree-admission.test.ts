import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTreeConcurrencyStore } from "../storage/tree-concurrency.js";
import { TreeWorkerAdmission } from "../runner/tree-admission.js";
import { WorkerScheduler } from "../runner/worker-scheduler.js";
import { runAgentSubprocess } from "../runner/single.js";
import { buildSubagentDetails } from "../types.js";
import { deferred, until } from "./helpers/message-subagent.js";

const agent = { name: "worker", description: "test", systemPrompt: "", source: "builtin" as const, filePath: "" };
function setup(limit = 1) {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/tree-admission-"));
  const store = createTreeConcurrencyStore({ directory: path.join(root, "ledger"), limit });
  return { root, store, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const makeDetails = (results: Parameters<typeof buildSubagentDetails>[3]) =>
  buildSubagentDetails("single", "spawn", null, results);

test("an unreadable global ledger rejects queued work instead of spawning or crashing its poll", async () => {
  const f = setup(),
    scheduler = new WorkerScheduler(1, { store: f.store, root: true });
  try {
    const prepared = scheduler.prepare("waiting");
    const revisions = fs.readdirSync(f.store.directory).filter((file) => /^state-\d+\.json$/.test(file));
    const latest = revisions.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0])).at(-1)!;
    fs.writeFileSync(path.join(f.store.directory, latest), "corrupt");
    await assert.rejects(prepared.promise, /Global worker admission unavailable/);
    assert.throws(() => scheduler.schedule("later", async () => {}), /shut down/);
  } finally {
    scheduler.shutdown();
    f.close();
  }
});

test("preparation is globally stoppable without reserving a live process slot", async () => {
  const f = setup(),
    scheduler = new WorkerScheduler(1, { store: f.store, root: true });
  try {
    const prepared = scheduler.prepare("preparing");
    assert.equal(f.store.snapshot()[0].status, "queued");
    assert.equal(f.store.snapshot()[0].pid, undefined);
    f.store.stopSubtree("preparing");
    await assert.rejects(prepared.promise);
    assert.equal(prepared.controller.signal.aborted, true);
    let started = false;
    const next = scheduler.schedule("next", async () => {
      started = true;
    });
    await next.promise;
    assert.equal(started, true);
  } finally {
    scheduler.shutdown();
    f.close();
  }
});

test("a stop between global claim and PID bind kills startup without retry or prompt", { timeout: 60000 }, async () => {
  const f = setup();
  const admission = new TreeWorkerAdmission(f.store, "raced");
  const marker = path.join(f.root, "prompted");
  const bind = admission.bindPid.bind(admission);
  admission.bindPid = (pid) => {
    f.store.stopSubtree(admission.token);
    return bind(pid);
  };
  try {
    const result = await runAgentSubprocess({
      cwd: f.root,
      agents: [agent],
      agentName: "worker",
      task: "never send",
      parentDepth: 0,
      maxDepth: 3,
      parentAgentStack: [],
      preventCycles: false,
      treeAdmission: admission,
      makeDetails,
      piCommandOverride: {
        command: process.execPath,
        argsPrefix: [
          "-e",
          `require('node:readline').createInterface({input:process.stdin}).on('line',()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad'));`,
          "--",
        ],
      },
    });
    assert.equal(result.exitCode, 130);
    assert.equal(result.stopReason, "aborted");
    assert.equal(fs.existsSync(marker), false);
    await until(() => f.store.get(admission.token)?.status === "released");
    assert.equal(f.store.snapshot().length, 1);
  } finally {
    admission.release();
    f.close();
  }
});

test("stopping during retry backoff cannot enqueue or spawn another attempt", { timeout: 60000 }, async () => {
  const f = setup(),
    scheduler = new WorkerScheduler(1, { store: f.store, root: true });
  const marker = path.join(f.root, "attempt");
  const task = scheduler.schedule("retry-stop", (signal, treeAdmission) =>
    runAgentSubprocess({
      cwd: f.root,
      agents: [agent],
      agentName: "worker",
      task: "stop retry",
      parentDepth: 0,
      maxDepth: 3,
      parentAgentStack: [],
      preventCycles: false,
      signal,
      treeAdmission,
      makeDetails,
      settings: { PI_SUBAGENT_STARTUP_RETRIES: "2" },
      startupTimeoutMsOverride: 1000,
      piCommandOverride: {
        command: process.execPath,
        argsPrefix: [
          "-e",
          `require('node:readline').createInterface({input:process.stdin}).on('line',()=>require('node:fs').appendFileSync(${JSON.stringify(marker)},'attempt\\n'));`,
          "--",
        ],
      },
    }),
  );
  try {
    await until(() => f.store.snapshot().some((entry) => entry.status === "released"));
    scheduler.stop("retry-stop");
    const result = await task.promise;
    assert.equal(result.exitCode, 130);
    assert.equal(result.stopReason, "aborted");
    assert.equal(fs.readFileSync(marker, "utf8"), "attempt\n");
    assert.equal(f.store.snapshot().length, 1);
  } finally {
    scheduler.shutdown();
    await task.promise.catch(() => undefined);
    f.close();
  }
});

test("startup retries enqueue fresh global tokens behind already queued siblings", { timeout: 60000 }, async () => {
  const f = setup(),
    scheduler = new WorkerScheduler(1, { store: f.store, root: true });
  const log = path.join(f.root, "attempts.json");
  const script = `
    const fs=require('node:fs');
    require('node:readline').createInterface({input:process.stdin}).on('line',()=>{
      const attempts=fs.existsSync(${JSON.stringify(log)})?JSON.parse(fs.readFileSync(${JSON.stringify(log)},'utf8')):[];
      attempts.push(process.env.PI_SUBAGENT_WORKER_TOKEN);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify(attempts));
      if(attempts.length===1)return;
      console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'retried'}],stopReason:'stop'}}));
      console.log(JSON.stringify({type:'agent_settled'}));
    });
  `;
  let retrier!: ReturnType<typeof scheduler.schedule>;
  try {
    retrier = scheduler.schedule("retrier", (signal, treeAdmission) =>
      runAgentSubprocess({
        cwd: f.root,
        agents: [agent],
        agentName: "worker",
        task: "retry",
        parentDepth: 0,
        maxDepth: 3,
        parentAgentStack: [],
        preventCycles: false,
        signal,
        treeAdmission,
        makeDetails,
        settings: { PI_SUBAGENT_STARTUP_RETRIES: "1" },
        startupTimeoutMsOverride: 1000,
        piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      }),
    );
    await until(() => fs.existsSync(log));
    const gate = deferred();
    const sibling = scheduler.schedule("sibling", async () => {
      await gate.promise;
    });
    await until(() => sibling.status === "started");
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(JSON.parse(fs.readFileSync(log, "utf8")).length, 1, "retry cannot overtake sibling's reserved slot");
    gate.resolve();
    await sibling.promise;
    const result = (await retrier.promise) as Awaited<ReturnType<typeof runAgentSubprocess>>;
    assert.equal(result.exitCode, 0);
    const tokens = JSON.parse(fs.readFileSync(log, "utf8")) as string[];
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
    assert.deepEqual(
      f.store.snapshot().map((entry) => entry.name),
      ["retrier", "sibling", "retrier"],
    );
  } finally {
    scheduler.shutdown();
    await retrier?.promise.catch(() => undefined);
    f.close();
  }
});
