import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BROKER_DIR_ENV, BROKER_SECRET_ENV } from "../broker/contracts.js";
import { ackBrokerJob, persistBrokerResult, submitBrokerJob } from "../broker/files.js";
import { shutdownRootBroker } from "../broker/root.js";
import { BROKER_CONSUMED_ENTRY, restoreBrokerJobs } from "../extension/broker-jobs.js";
import { schedulerFor } from "../extension/scheduler.js";
import { WORKER_TOKEN_ENV } from "../runner/tree-admission.js";
import { makeResult } from "./helpers/results.js";
import { customEntry, messageEntry } from "./helpers/extension.js";
import { fixture, until } from "./helpers/message-subagent.js";
import { serializedDetails } from "./helpers/json.js";

test("an ACK without persisted completion context replays the saved result, never re-runs the child", async () => {
  const f = await fixture();
  const scheduler = schedulerFor(f.state);
  const endpoint = scheduler.brokerEndpoint!;
  const store = scheduler.treeStore!;
  const parent = store.enqueue("Parent");
  assert.equal(store.claim(parent), "running");
  store.bindPid(parent, process.pid);
  const env = Object.fromEntries(
    [BROKER_DIR_ENV, BROKER_SECRET_ENV, WORKER_TOKEN_ENV].map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, {
    [BROKER_DIR_ENV]: endpoint.directory,
    [BROKER_SECRET_ENV]: endpoint.secret,
    [WORKER_TOKEN_ENV]: parent,
  });
  try {
    const receipt = submitBrokerJob(endpoint, {
      ownerToken: parent,
      ownerId: f.state.currentOwnerId,
      toolCallId: "original-call",
      taskIndex: 3,
      name: f.name,
      agents: [],
      task: { agent: "worker", task: "finished child" },
      cwd: f.ctx.cwd,
      projectTrusted: true,
      parentDepth: 1,
      maxDepth: 3,
      parentAgentStack: [],
      preventCycles: false,
      budget: f.budget,
      sessionDir: f.sessionDir,
      sessionRoot: f.state.currentSubagentSessionRoot,
      namesFile: f.state.currentNamesFile,
      resumeSession: true,
    });
    persistBrokerResult(
      endpoint,
      receipt.id,
      makeResult({
        name: f.name,
        finalOutput: "durable child answer",
        budget: f.budget,
        stderr: "harmless diagnostic",
      }),
    );
    ackBrokerJob(endpoint, receipt.id);
    const entries: SessionEntry[] = [customEntry(BROKER_CONSUMED_ENTRY, { id: receipt.id })];
    const sent: Array<Parameters<ExtensionAPI["sendMessage"]>[0]> = [];
    f.state.pi.sendMessage = (message) => {
      sent.push(message);
    };
    f.state.currentDepth = 1;
    const ctx = {
      ...f.ctx,
      sessionManager: { getEntries: () => entries, getLeafId: () => null, getSessionFile: () => undefined },
    } as unknown as ExtensionContext;
    f.state.latestSessionCtx = ctx;
    assert.equal(await restoreBrokerJobs(f.state, ctx), true);
    assert.equal(
      f.state.activeResumeNames.has(f.name),
      true,
      "restored resume watches must guard against duplicate launches",
    );
    await until(() => sent.length === 1);
    assert.equal(sent[0].customType, "subagent_completion");
    assert.equal(Reflect.get(sent[0].details!, "asyncJobId"), "original-call");
    assert.equal(Reflect.get(sent[0].details!, "asyncTaskIndex"), 3);
    assert.match(JSON.stringify(sent[0].content), /durable child answer/);
    assert.doesNotMatch(
      JSON.stringify(sent[0].content),
      /failed:/,
      "successful stderr diagnostics must not become child failures",
    );
    entries.push(
      messageEntry(
        {
          role: "custom",
          customType: sent[0].customType,
          content: sent[0].content,
          display: true,
          details: serializedDetails(sent[0].details),
          timestamp: Date.now(),
        },
        "persisted-completion",
      ),
    );
    assert.equal(await restoreBrokerJobs(f.state, ctx), false);
    await delay(30);
    assert.equal(sent.length, 1, "persisted completion context must not be injected twice");
    assert.equal(store.snapshot().filter((entry) => entry.name === f.name).length, 1);
  } finally {
    await shutdownRootBroker(endpoint);
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await f.close();
  }
});
