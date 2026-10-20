import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runAttempt } from "../runner/attempt.js";
import { TreeWorkerAdmission } from "../runner/tree-admission.js";
import { createTreeConcurrencyStore } from "../storage/tree-concurrency.js";
import { buildSubagentDetails } from "../types.js";
import { makeRunningResult } from "./helpers/results.js";
import { settingsFixture } from "./helpers/settings.js";

test(
  "a subtree stop racing after admission but before PID binding kills the new process before its first prompt",
  {
    timeout: 10000,
  },
  async () => {
    const f = settingsFixture();
    const store = createTreeConcurrencyStore({ directory: path.join(f.root, "ledger"), limit: 2 });
    const parent = store.enqueue("Parent");
    assert.equal(store.claim(parent), "running");
    class RacingAdmission extends TreeWorkerAdmission {
      override bindPid(pid: number): boolean {
        store.stopSubtree(parent);
        return super.bindPid(pid);
      }
    }
    const admission = new RacingAdmission(store, "Raced-child", parent);
    const prompted = path.join(f.root, "prompted");
    const script = `
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      if (JSON.parse(line).type === 'prompt') require('node:fs').writeFileSync(${JSON.stringify(prompted)}, 'resurrected');
    });
    setInterval(() => {}, 1000);
  `;
    try {
      const result = makeRunningResult();
      const outcome = await runAttempt(
        {
          cwd: f.root,
          agents: [],
          agentName: "worker",
          task: "must not start",
          parentDepth: 1,
          parentAgentStack: ["parent"],
          maxDepth: 3,
          preventCycles: false,
          treeAdmission: admission,
          piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
          startupTimeoutMsOverride: 0,
          idleTimeoutMsOverride: 0,
          terminationTimeoutMsOverride: 5000,
          makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
        },
        result,
        [],
        "must not start",
        0,
        () => {},
      );
      assert.equal(outcome.wasAborted, true, "a stop race must disable startup retries");
      assert.equal(outcome.exitCode, 130);
      assert.equal(fs.existsSync(prompted), false, "the newly bound process must not receive its initial model prompt");
      assert.equal(store.claim(admission.token), "canceled");
      assert.equal(
        store.snapshot().some((entry) => entry.name === "Raced-child" && store.isProcessAlive(entry)),
        false,
      );
      const late = store.enqueue("Too-late-grandchild", admission.token);
      assert.equal(store.claim(late), "canceled", "the late bound child's tombstone must block new descendants too");
    } finally {
      store.release(parent);
      f.close();
    }
  },
);
