import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { createBudget, readBudget, reserveSubagentBudgets, SUBAGENT_BUDGET_CUSTOM_TYPE } from "../budget.js";
import { submitBrokerJob, persistBrokerResult } from "../broker/files.js";
import { buildSubagentDetails } from "../types.js";
import { updateNamesRegistry, SUBAGENT_NAMES_CUSTOM_TYPE } from "../names.js";
import { RESUME_PROVIDER } from "../shared.js";
import { createExtensionHarness, customEntry } from "./helpers/extension.js";
import { settingsFixture } from "./helpers/settings.js";
import { simulatedTreeWorker } from "./helpers/tree-concurrency.js";
import { until } from "./helpers/message-subagent.js";
import { assistantSubagentCall, subagentToolResult } from "./fixtures/resume.js";
import { makeResult } from "./helpers/results.js";

for (const disableAuto of [false, true]) {
  test(`parked startup reattaches broker work without synthetic recovery, disableAuto ${disableAuto}`, async () => {
    const f = settingsFixture();
    const parent = simulatedTreeWorker(path.join(f.root, "tree"), "Parent", 4);
    try {
      f.write(f.agent, { resume: { disableAuto, prompt: true } });
      Object.assign(process.env, parent.env, { PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "3" });
      const ownerId = "stable-parent-owner",
        namesFile = path.join(f.root, "names.json");
      const task = { agent: "worker", task: "saved child task", max_subagents_allowed: 0 };
      const budget = createBudget(path.join(f.root, "parent-budget"), 2);
      const [childBudget] = reserveSubagentBudgets(budget, "parked-call", [task]);
      const sessionDir = path.join(f.root, "child-session");
      await updateNamesRegistry(namesFile, (registry) => {
        registry.agents.Child = {
          name: "Child",
          agent: "worker",
          task: task.task,
          ownerSessionId: ownerId,
          sessionDir,
          createdAt: Date.now(),
          forks: {},
          budget: childBudget,
        };
      });
      const endpoint = { directory: parent.env.PI_SUBAGENT_BROKER_DIR, secret: parent.env.PI_SUBAGENT_BROKER_SECRET };
      const receipt = submitBrokerJob(endpoint, {
        ownerToken: parent.token,
        ownerId,
        toolCallId: "parked-call",
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
      const child = makeResult({
        ...task,
        name: "Child",
        sessionDir,
        budget: childBudget,
        exitCode: 0,
        finalOutput: "saved child result",
      });
      persistBrokerResult(endpoint, receipt.id, child);
      const entries = [
        customEntry(SUBAGENT_BUDGET_CUSTOM_TYPE, budget),
        customEntry(SUBAGENT_NAMES_CUSTOM_TYPE, { namesFile, ownerId }),
        assistantSubagentCall("parked-call", [task]),
        subagentToolResult(
          "parked-call",
          Object.assign(
            buildSubagentDetails("parallel", "spawn", null, [{ ...child, exitCode: -1, finalOutput: undefined }]),
            { asyncJobId: "parked-call" },
          ),
          false,
        ),
      ];
      const before = readBudget(budget);
      const host = createExtensionHarness();
      const base = host.makeCtx(entries, { cwd: f.project, hasUI: true, mode: "rpc" });
      const ctx = { ...base, sessionManager: { ...base.sessionManager, getSessionFile: () => undefined } };
      await host.emit("session_start", { reason: "startup" }, ctx);
      await until(() => host.calls.sentMessages.length === 1);
      assert.equal(host.calls.confirms, 0, "parking continuation must not prompt for crash recovery");
      assert.equal(
        host.calls.setModel.some((model) => model.provider === RESUME_PROVIDER),
        false,
      );
      const message = host.calls.sentMessages[0].message;
      assert.equal(message.customType, "subagent_completion");
      assert.equal(Reflect.get(message.details!, "asyncJobId"), "parked-call");
      assert.equal(Reflect.get(message.details!, "asyncTaskIndex"), 0);
      assert.match(JSON.stringify(message.content), /saved child result/);
      assert.equal(parent.store.snapshot().length, 2, "restoration must not submit another child");
      assert.deepEqual(readBudget(budget), before, "restoration must not reserve more budget");
      await host.emit("session_shutdown", {}, ctx);
    } finally {
      await parent.close();
      f.close();
    }
  });
}
