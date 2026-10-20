import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import { test } from "node:test";
import { createBudget, reserveSubagentBudgets, SUBAGENT_BUDGET_CUSTOM_TYPE } from "../budget.js";
import { submitBrokerJob } from "../broker/files.js";
import { updateNamesRegistry, SUBAGENT_NAMES_CUSTOM_TYPE } from "../names.js";
import { buildSubagentDetails } from "../types.js";
import { createExtensionHarness, customEntry } from "./helpers/extension.js";
import { settingsFixture } from "./helpers/settings.js";
import { simulatedTreeWorker } from "./helpers/tree-concurrency.js";
import { assistantSubagentCall, subagentToolResult } from "./fixtures/resume.js";
import { makeResult } from "./helpers/results.js";

for (const status of ["queued", "suspended", "waking"] as const) {
  test(`automatic restoration preserves a ${status} child instead of submitting it again`, async () => {
    const f = settingsFixture();
    const parent = simulatedTreeWorker(path.join(f.root, "tree"), "Parent", 2);
    // Keep this test's resource states fixed; execution is covered by the real-process integration tests.
    await parent.close();
    const host = createExtensionHarness();
    let worker: ReturnType<typeof spawn> | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      f.write(f.agent, { resume: { disableAuto: false, prompt: true } });
      Object.assign(process.env, parent.env, { PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "3" });
      const budget = createBudget(path.join(f.root, "budget"), 2);
      const task = { agent: "worker", task: "saved child", max_subagents_allowed: 1 };
      const [childBudget] = reserveSubagentBudgets(budget, "saved-call", [task]);
      const namesFile = path.join(f.root, "names.json"),
        sessionDir = path.join(f.root, "child-session");
      await updateNamesRegistry(namesFile, (registry) => {
        registry.agents.Child = {
          name: "Child",
          agent: task.agent,
          task: task.task,
          budget: childBudget,
          ownerSessionId: "parent-owner",
          sessionDir,
          createdAt: Date.now(),
          forks: {},
        };
      });
      const endpoint = { directory: parent.env.PI_SUBAGENT_BROKER_DIR, secret: parent.env.PI_SUBAGENT_BROKER_SECRET };
      const receipt = submitBrokerJob(endpoint, {
        ownerToken: parent.token,
        ownerId: "parent-owner",
        toolCallId: "saved-call",
        taskIndex: 0,
        name: "Child",
        agents: [],
        task,
        cwd: f.project,
        projectTrusted: true,
        parentDepth: 1,
        maxDepth: 3,
        parentAgentStack: [],
        preventCycles: true,
        budget: childBudget,
        sessionDir,
        sessionRoot: f.root,
        namesFile,
        resumeSession: false,
      });
      if (status !== "queued") {
        assert.equal(parent.store.claim(receipt.token), "running");
        worker = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
        closed = once(worker, "close");
        assert.ok(worker.pid);
        parent.store.bindPid(receipt.token, worker.pid);
        parent.store.enqueue("Grandchild", receipt.token);
        parent.store.markWaiting(receipt.token, true);
        assert.equal(parent.store.get(receipt.token)?.status, "parking");
        worker.kill("SIGKILL");
        await closed;
        assert.equal(parent.store.get(receipt.token)?.status, "suspended");
        if (status === "waking") parent.store.requestWake(receipt.token);
      }
      const pending = makeResult({ ...task, name: "Child", sessionDir, budget: childBudget, exitCode: -1 });
      const entries = [
        customEntry(SUBAGENT_BUDGET_CUSTOM_TYPE, budget),
        customEntry(SUBAGENT_NAMES_CUSTOM_TYPE, { namesFile, ownerId: "parent-owner" }),
        assistantSubagentCall("saved-call", [task]),
        subagentToolResult(
          "saved-call",
          Object.assign(buildSubagentDetails("parallel", "spawn", null, [pending]), { asyncJobId: "saved-call" }),
          false,
        ),
      ];
      const base = host.makeCtx(entries, { cwd: f.project, mode: "rpc", hasUI: true });
      const ctx = { ...base, sessionManager: { ...base.sessionManager, getSessionFile: () => undefined } };
      const before = parent.store.snapshot();
      await host.emit("session_start", { reason: "startup" }, ctx);
      assert.equal(host.calls.confirms, 0);
      assert.equal(host.calls.setModel.length, 0, "live broker work must not trigger synthetic recovery");
      assert.deepEqual(parent.store.snapshot(), before, "watch restoration cannot claim or recreate worker slots");
      assert.equal(parent.store.get(receipt.token)?.status, status);
      const message = await host.call("message_subagent", "check-status", { name: "Child", message: "continue" }, ctx);
      assert.match(JSON.stringify(message.content), status === "queued" ? /queued/ : /suspended/);
      assert.equal(parent.store.get(receipt.token)?.status, status);
      await host.emit("session_shutdown", {}, ctx);
    } finally {
      worker?.kill("SIGKILL");
      await closed;
      await parent.close();
      f.close();
    }
  });
}
