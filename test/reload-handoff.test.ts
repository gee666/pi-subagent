import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createEventBus, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { KEEP_ON_NEXT_ABORT_EVENT } from "../extension/interrupt.js";
import { publishReloadHandoff } from "../extension/reload-handoff.js";
import { deferDuringReload } from "../extension/runtime.js";
import { createExtensionState } from "../extension/state.js";
import { createExtensionHarness } from "./helpers/extension.js";
import { hostDouble } from "./helpers/host-double.js";
import { settingsFixture } from "./helpers/settings.js";

const SLOT = Symbol.for("pi-subagent.reload-handoff");

async function until(condition: () => boolean, message: string, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await delay(10);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One fake worker process per test, released by a gate file and reporting its pid. */
function setup() {
  const f = settingsFixture();
  const script = path.join(f.root, "worker.cjs");
  const file = (name: string) => path.join(f.root, name);
  fs.writeFileSync(
    script,
    `const fs = require("node:fs");
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      if (JSON.parse(line).type !== "prompt") return;
      fs.writeFileSync(${JSON.stringify(file("pid"))}, String(process.pid));
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(file("release"))})) return;
        clearInterval(timer);
        console.log(JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "finished" }], stopReason: "stop" } }));
        console.log(JSON.stringify({ type: "agent_settled" }));
      }, 10);
    });`,
  );
  f.write(f.agent, { runner: { command: process.execPath, argsPrefix: [script] }, limits: { total: 4 } });
  const entries: SessionEntry[] = [];
  const instance = (options: Parameters<typeof createExtensionHarness>[0] = {}) => {
    const host = createExtensionHarness(options);
    return { host, ctx: host.makeCtx(entries, { cwd: f.project, hasUI: false, isIdle: () => false }) };
  };
  return {
    f,
    instance,
    release: () => fs.writeFileSync(file("release"), "go"),
    async launch(first: ReturnType<typeof instance>) {
      await first.host.emit("session_start", { reason: "startup" }, first.ctx);
      const started = await first.host.call(
        "subagents",
        "launch",
        { tasks: [{ task: "work", max_subagents_allowed: 0 }] },
        first.ctx,
      );
      assert.equal(started.isError, false);
      await until(() => fs.existsSync(file("pid")), "worker never started");
      return { name: started.details.results[0].name!, pid: Number(fs.readFileSync(file("pid"), "utf8")) };
    },
    completions: (host: ReturnType<typeof instance>["host"]) =>
      host.calls.sentMessages.filter(({ message }) => message.customType === "subagent_completion"),
  };
}

test("a reloaded instance adopts running workers and receives completions raised during the hand-off", async () => {
  const t = setup();
  const first = t.instance();
  let second: ReturnType<typeof t.instance> | undefined;
  try {
    const worker = await t.launch(first);
    await first.host.emit("session_shutdown", { reason: "reload" }, first.ctx);
    // Pi invalidates the old instance's API right after its shutdown handlers.
    for (const key of ["sendMessage", "sendUserMessage", "appendEntry", "setActiveTools", "getActiveTools"])
      Reflect.set(first.host.pi, key, () => assert.fail(`stale pi.${key} used after reload`));
    assert.ok(alive(worker.pid), "reload must not stop the worker");
    t.release();
    await until(() => !alive(worker.pid), "worker did not finish");
    await delay(50);
    assert.equal(t.completions(first.host).length, 0, "the stale instance must not deliver");
    second = t.instance();
    await second.host.emit("session_start", { reason: "reload" }, second.ctx);
    await until(() => t.completions(second!.host).length === 1, "buffered completion was not replayed");
    const [completion] = t.completions(second.host);
    assert.equal(completion.message.content, `Subagent ${worker.name} finished:\nfinished`);
    assert.deepEqual(completion.options, { deliverAs: "steer", triggerTurn: true });
    assert.equal(Reflect.get(globalThis, SLOT), undefined);
  } finally {
    if (second) await second.host.emit("session_shutdown", { reason: "quit" }, second.ctx);
    t.f.close();
  }
});

test("the adopting instance owns handed-off workers: stop_subagent, Escape and a later quit stop them", async () => {
  for (const ending of ["stop_subagent", "escape", "quit"] as const) {
    const t = setup();
    const first = t.instance();
    let second: ReturnType<typeof t.instance> | undefined;
    try {
      const worker = await t.launch(first);
      await first.host.emit("session_shutdown", { reason: "reload" }, first.ctx);
      second = t.instance();
      // The successor claims at load, so no other instance in this process can.
      assert.equal(Reflect.get(globalThis, SLOT), undefined);
      await second.host.emit("session_start", { reason: "reload" }, second.ctx);
      await delay(100);
      assert.ok(alive(worker.pid));
      if (ending === "stop_subagent") {
        const stopped = await second.host.call("stop_subagent", "stop", { name: worker.name }, second.ctx);
        assert.equal(stopped.isError, false);
      } else if (ending === "escape") await second.host.emit("agent_settled", { aborted: true }, second.ctx);
      else await second.host.emit("session_shutdown", { reason: "quit" }, second.ctx);
      await until(() => !alive(worker.pid), `${ending} did not stop the adopted worker`);
      await delay(50);
      // Escape leaves only silent stop accounting; nothing starts another turn.
      for (const { message, options } of t.completions(second.host)) {
        assert.equal(message.content, `Subagent ${worker.name} stopped as requested.`);
        assert.deepEqual(options, { triggerTurn: false });
      }
    } finally {
      if (second) await second.host.emit("session_shutdown", { reason: "quit" }, second.ctx);
      t.f.close();
    }
  }
});

test("an incompatible or mismatched successor stops handed-off workers instead of leaking them", async () => {
  for (const successor of ["protocol", "session"] as const) {
    const t = setup();
    const first = t.instance();
    let second: ReturnType<typeof t.instance> | undefined;
    try {
      const worker = await t.launch(first);
      await first.host.emit("session_shutdown", { reason: "reload" }, first.ctx);
      if (successor === "protocol") {
        const slot: unknown = Reflect.get(globalThis, SLOT);
        assert.ok(slot && typeof slot === "object");
        Reflect.set(slot, "protocol", -1);
      }
      second = t.instance();
      if (successor === "session") await second.host.emit("session_start", { reason: "new" }, second.ctx);
      await until(() => !alive(worker.pid), `${successor} mismatch left the worker running`);
      assert.equal(Reflect.get(globalThis, SLOT), undefined);
    } finally {
      if (second) await second.host.emit("session_shutdown", { reason: "quit" }, second.ctx);
      t.f.close();
    }
  }
});

test("an unclaimed hand-off falls back to the old shutdown and drops its buffered work", async () => {
  const state = createExtensionState(hostDouble<ExtensionAPI>({ getFlag: () => undefined }));
  let stopped = 0;
  publishReloadHandoff(
    state,
    async () => {
      stopped++;
    },
    10,
  );
  const replayed: string[] = [];
  assert.equal(
    deferDuringReload(state, state.lifecycleGeneration, () => replayed.push("late")),
    true,
  );
  assert.equal(
    deferDuringReload(state, state.lifecycleGeneration + 1, () => replayed.push("stale")),
    false,
  );
  await until(() => stopped === 1, "adoption deadline did not stop the work", 1000);
  assert.equal(state.reloadHandoff, undefined);
  assert.equal(Reflect.get(globalThis, SLOT), undefined);
  assert.equal(
    deferDuringReload(state, state.lifecycleGeneration, () => replayed.push("after")),
    false,
  );
  assert.deepEqual(replayed, []);
});

test(`${KEEP_ON_NEXT_ABORT_EVENT} keeps workers for exactly the next abort`, async () => {
  const t = setup();
  const events = createEventBus();
  const lead = t.instance({ events });
  try {
    const worker = await t.launch(lead);
    events.emit(KEEP_ON_NEXT_ABORT_EVENT, {});
    await lead.host.emit("agent_settled", { aborted: true }, lead.ctx);
    await delay(100);
    assert.ok(alive(worker.pid), "the signalled abort must leave workers running");
    await lead.host.emit("agent_settled", { aborted: true }, lead.ctx);
    await until(() => !alive(worker.pid), "the signal must not outlive its abort");
  } finally {
    await lead.host.emit("session_shutdown", { reason: "quit" }, lead.ctx);
    t.f.close();
  }
});
