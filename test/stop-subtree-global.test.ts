import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { treeStoreFor, shutdownScheduler } from "../extension/scheduler.js";
import { registerStopSubagentTool } from "../extension/stop-tool.js";
import { killPidTreeImmediately } from "../runner/launch.js";
import { loadSubagentSettings } from "../settings.js";
import { readNamesRegistry, updateNamesRegistry, SUBAGENT_NAMES_CUSTOM_TYPE } from "../names.js";
import { customEntry } from "./helpers/extension.js";
import { buildSubagentDetails, isSubagentDetails } from "../types.js";
import { findLatestResumableSubagentCalls } from "../resume.js";
import { fixture, until } from "./helpers/message-subagent.js";
import { assistantSubagentCall, subagentToolResult, makeResult, makeCtx, messageEntry } from "./fixtures/resume.js";
import { serializedDetails } from "./helpers/json.js";

function alive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0] !== "Z";
  } catch {
    return false;
  }
}

async function subtreeFixture() {
  const f = await fixture();
  f.write(f.agent, { limits: { concurrency: 4 } });
  f.state.settings = loadSubagentSettings(f.project, true);
  const store = treeStoreFor(f.state);
  const childFile = path.join(f.root, "child-pid");
  const grandchildFile = path.join(f.root, "grandchild-pid");
  const grandchildScript = `require('node:fs').writeFileSync(${JSON.stringify(grandchildFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const childScript = `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], {detached:true,stdio:'ignore'}).unref();
    require('node:fs').writeFileSync(${JSON.stringify(childFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
  const rootScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {detached:true,stdio:'ignore'}).unref(); setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, ["-e", rootScript], { detached: true, stdio: "ignore" });
  const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const closed = [once(parent, "close"), once(sibling, "close")];
  let child = 0;
  let grandchild = 0;
  const close = async () => {
    for (const pid of [parent.pid, child, grandchild, sibling.pid]) if (pid && alive(pid)) killPidTreeImmediately(pid);
    await Promise.all(closed);
    shutdownScheduler(f.state);
    await f.close();
  };
  try {
    await until(() => fs.existsSync(childFile) && fs.existsSync(grandchildFile));
    child = Number(fs.readFileSync(childFile, "utf8"));
    grandchild = Number(fs.readFileSync(grandchildFile, "utf8"));
    assert.ok(parent.pid && sibling.pid);
    const admit = (name: string, pid: number, parentToken?: string, ownerPid = process.pid) => {
      const token = store.enqueue(name, parentToken, ownerPid);
      assert.equal(store.claim(token), "running");
      store.bindPid(token, pid);
      return token;
    };
    const parentToken = admit("Parent", parent.pid);
    const childToken = admit("Child", child, parentToken, parent.pid);
    const grandchildToken = admit("Grandchild", grandchild, childToken, child);
    const siblingToken = admit("Sibling", sibling.pid);
    const queuedToken = store.enqueue("Queued-descendant", grandchildToken, grandchild);
    assert.equal(store.claim(queuedToken), "queued");
    await updateNamesRegistry(f.state.currentNamesFile, (registry) => {
      for (const name of ["Parent", "Child", "Grandchild", "Queued-descendant", "Sibling"]) {
        registry.agents[name] = {
          name,
          agent: "worker",
          task: name,
          ownerSessionId: ["Parent", "Sibling"].includes(name)
            ? f.state.currentOwnerId
            : name === "Child"
              ? "parent-owner"
              : "child-owner",
          sessionDir: path.join(f.root, name),
          createdAt: Date.now(),
          forks: {},
        };
      }
    });
    let stop: ToolDefinition | undefined;
    const register = f.state.pi.registerTool;
    f.state.pi.registerTool = (tool) => {
      stop = tool as unknown as ToolDefinition;
    };
    registerStopSubagentTool(f.state);
    f.state.pi.registerTool = register;
    assert.ok(stop);
    return {
      ...f,
      store,
      parent: parent.pid,
      child,
      grandchild,
      sibling: sibling.pid,
      parentToken,
      childToken,
      grandchildToken,
      siblingToken,
      queuedToken,
      close,
      stop: (name: string | string[]) => stop!.execute("stop-subtree", { name }, undefined, undefined, f.ctx),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function reported(result: Awaited<ReturnType<ToolDefinition["execute"]>>): Map<string, string> {
  assert.ok(isSubagentDetails(result.details));
  const statuses = Reflect.get(result.details, "statuses") as Array<{ name: string; status: string }>;
  assert.ok(Array.isArray(statuses));
  return new Map(statuses.map(({ name, status }) => [name, status]));
}

const linuxOnly = { skip: process.platform !== "linux", timeout: 15000 };

test("stopping a parked parent cancels its wake and kills descendants that are parking", linuxOnly, async () => {
  for (const wake of [false, true]) {
    const f = await subtreeFixture();
    try {
      for (const token of [f.childToken, f.grandchildToken, f.queuedToken]) f.store.adopt(token);
      f.store.markWaiting(f.parentToken, true);
      assert.equal(f.store.get(f.parentToken)?.status, "parking");
      process.kill(f.parent, "SIGKILL"); // Parent only: detached children must remain supervised.
      await until(() => !alive(f.parent));
      assert.equal(f.store.get(f.parentToken)?.status, "suspended");
      if (wake) f.store.requestWake(f.parentToken);
      f.store.setLimit(3);
      f.store.markWaiting(f.childToken, true);
      assert.equal(f.store.get(f.childToken)?.status, "parking");
      const statuses = reported(await f.stop("Parent"));
      assert.equal(statuses.get("Parent"), "canceled");
      assert.equal(statuses.get("Child"), "stopped");
      await until(() => !alive(f.child) && !alive(f.grandchild));
      assert.equal(alive(f.sibling), true);
      assert.equal(f.store.claim(f.parentToken), "canceled");
      assert.equal(f.store.claim(f.queuedToken), "canceled");
    } finally {
      await f.close();
    }
  }
});

test(
  "stopping a global parent kills detached descendants and cancels queued descendants without harming siblings",
  linuxOnly,
  async () => {
    const f = await subtreeFixture();
    try {
      assert.equal(f.state.activeSubagents.size, 0, "all targets are remote, not local handles");
      const result = await f.stop("Parent");
      assert.deepEqual(
        reported(result),
        new Map([
          ["Parent", "stopped"],
          ["Child", "stopped"],
          ["Grandchild", "stopped"],
          ["Queued-descendant", "canceled"],
        ]),
      );
      await until(() => [f.parent, f.child, f.grandchild].every((pid) => !alive(pid)));
      assert.equal(alive(f.sibling), true);
      assert.equal(f.store.get(f.queuedToken)?.status, "canceled");
      assert.equal(f.store.claim(f.queuedToken), "canceled", "a canceled queued child must never be admitted");
      assert.equal(f.store.get(f.siblingToken)?.status, "running");
      const records = readNamesRegistry(f.state.currentNamesFile).agents;
      for (const name of ["Parent", "Child", "Grandchild", "Queued-descendant"]) {
        assert.equal(
          typeof records[name].stoppedAt,
          "number",
          "remote child sessions must see shared recovery markers",
        );
      }
      assert.equal(records.Sibling.stoppedAt, undefined);

      const names = ["Parent", "Child", "Grandchild", "Queued-descendant", "Sibling"];
      const tasks = names.map((name) => ({ agent: "worker", task: name }));
      const details = Object.assign(
        buildSubagentDetails(
          "parallel",
          "spawn",
          null,
          names.map((name) => makeResult({ name, task: name, exitCode: -1, sessionDir: `/workers/${name}` })),
        ),
        { asyncJobId: "launch" },
      );
      const entries = [
        assistantSubagentCall("launch", tasks),
        subagentToolResult("launch", details, false),
        messageEntry(
          {
            role: "toolResult",
            toolName: "stop_subagent",
            toolCallId: "stop-subtree",
            isError: Reflect.get(result, "isError") === true,
            content: result.content,
            details: serializedDetails(result.details),
            timestamp: Date.now(),
          },
          "stopped",
        ),
      ];
      const plans = findLatestResumableSubagentCalls(makeCtx(entries));
      assert.deepEqual(
        plans.flatMap((plan) => plan.details?.results.map((worker) => worker.name) ?? []),
        ["Sibling"],
        "stop output must suppress recovery for every stopped or canceled descendant",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "the root cannot stop grandchildren even by durable name or a forged matching registry owner",
  linuxOnly,
  async () => {
    const f = await subtreeFixture();
    try {
      for (const forgeOwner of [false, true]) {
        if (forgeOwner)
          await updateNamesRegistry(f.state.currentNamesFile, (registry) => {
            registry.agents.Child.ownerSessionId = f.state.currentOwnerId;
          });
        const result = await f.stop("Child");
        assert.equal(Reflect.get(result, "isError"), true);
        assert.deepEqual(reported(result), new Map([["Child", "error"]]));
        assert.match(JSON.stringify(result.content), /direct child|direct children/);
        assert.ok([f.parent, f.child, f.grandchild, f.sibling].every(alive));
        assert.equal(f.store.get(f.childToken)?.status, "running");
        assert.equal(f.store.claim(f.queuedToken), "queued");
      }
      const ownParent = await f.stop("Parent");
      assert.notEqual(Reflect.get(ownParent, "isError"), true);
      assert.equal(reported(ownParent).get("Queued-descendant"), "canceled");
      await until(() => [f.parent, f.child, f.grandchild].every((pid) => !alive(pid)));
      assert.equal(alive(f.sibling), true);
    } finally {
      await f.close();
    }
  },
);

test("stopping a parent suppresses historical failed descendants in a remote child session", linuxOnly, async () => {
  const f = await subtreeFixture();
  try {
    const startedAt = Date.now() - 100;
    killPidTreeImmediately(f.grandchild);
    await until(() => !alive(f.grandchild));
    assert.equal(f.store.get(f.grandchildToken)?.status, "released");
    assert.equal(f.store.get(f.queuedToken)?.status, "canceled");
    await f.stop("Parent");
    const records = readNamesRegistry(f.state.currentNamesFile).agents;
    assert.equal(typeof records.Grandchild.stoppedAt, "number", "a failed terminal descendant must not resurrect");
    assert.equal(
      typeof records["Queued-descendant"].stoppedAt,
      "number",
      "an already-canceled descendant needs a shared marker too",
    );
    const names = ["Grandchild", "Queued-descendant", "Sibling"];
    const tasks = names.map((name) => ({ agent: "worker", task: name }));
    const details = Object.assign(
      buildSubagentDetails(
        "parallel",
        "spawn",
        null,
        names.map((name) => makeResult({ name, task: name, startedAt, sessionDir: `/workers/${name}` })),
      ),
      { asyncJobId: "remote-children" },
    );
    const entries = [
      customEntry(SUBAGENT_NAMES_CUSTOM_TYPE, {
        namesFile: f.state.currentNamesFile,
        ownerId: "remote-parent",
      }),
      assistantSubagentCall("remote-children", tasks),
      subagentToolResult("remote-children", details),
    ];
    assert.deepEqual(
      findLatestResumableSubagentCalls(makeCtx(entries)).flatMap(
        (plan) => plan.details?.results.map((worker) => worker.name) ?? [],
      ),
      ["Sibling"],
    );
  } finally {
    await f.close();
  }
});

test(
  "subtree tombstones reject new descendant registration and PID binding raced after admission",
  linuxOnly,
  async () => {
    const f = await subtreeFixture();
    const raced = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const closed = once(raced, "close");
    try {
      assert.ok(raced.pid);
      f.store.stopSubtree(f.queuedToken);
      f.store.setLimit(5);
      const admitted = f.store.enqueue("Raced-worker", f.childToken, f.child);
      assert.equal(f.store.claim(admitted), "running");
      const stopped = f.store.stopSubtree(f.parentToken);
      assert.ok(stopped.some(({ name }) => name === "Raced-worker"));
      const late = f.store.enqueue("Too-late", f.childToken, f.child);
      assert.equal(f.store.claim(late), "canceled");
      f.store.bindPid(admitted, raced.pid);
      const bound = f.store.get(admitted)!;
      assert.equal(bound.status, "stopping");
      assert.equal(f.store.isProcessAlive(bound), true);
      f.store.release(admitted);
      assert.equal(
        f.store.get(admitted)?.status,
        "stopping",
        "binding after a stop must not free the live process slot",
      );
      if (f.store.isProcessAlive(bound)) killPidTreeImmediately(bound.pid!);
      await closed;
      assert.equal(f.store.claim(admitted), "canceled", "a bound raced worker cannot regain admission after it exits");
      assert.equal(alive(f.sibling), true);
    } finally {
      if (raced.pid && alive(raced.pid)) killPidTreeImmediately(raced.pid);
      await closed;
      await f.close();
    }
  },
);
