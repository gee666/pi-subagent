import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { acquireNamesLock } from "../storage/names-lock.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readBudget } from "../budget.js";
import { readNamesRegistry, SUBAGENT_NAMES_CUSTOM_TYPE, SUBAGENT_NAMES_FILE_ENV } from "../names.js";
import { findLatestResumableSubagentCalls } from "../resume.js";
import { markStoppedNames } from "../storage/stopped-workers.js";
import { buildSubagentDetails } from "../types.js";
import { assistantSubagentCall, subagentToolResult, makeResult, makeCtx } from "./fixtures/resume.js";
import { customEntry } from "./helpers/extension.js";
import { fixture } from "./helpers/message-subagent.js";

test("shared subtree stop markers persist without waiting for a killed worker's names lock", async () => {
  const f = await fixture();
  const unlock = await acquireNamesLock(f.state.currentNamesFile);
  let marker: Promise<void> | undefined;
  try {
    const at = Date.now();
    marker = markStoppedNames(f.state.currentNamesFile, [f.name], at);
    const completed = await Promise.race([marker.then(() => true), delay(500).then(() => false)]);
    assert.equal(completed, true, "recovery protection must not wait for the stopped process's stale registry lock");
    assert.equal(readNamesRegistry(f.state.currentNamesFile).agents[f.name].stoppedAt, at);
  } finally {
    unlock();
    await marker;
    await f.close();
  }
});

for (const identity of ["inherited", "persisted"] as const) {
  test(`remote child-session recovery uses ${identity} shared stop markers without a local stop result`, async () => {
    const f = await fixture();
    try {
      const stoppedAt = Date.now() + 1000;
      const budget = readBudget(f.budget);
      await markStoppedNames(f.state.currentNamesFile, [f.name], stoppedAt);
      const names = [f.name, "Unaffected-child"];
      const tasks = names.map((name) => ({ agent: "worker", task: name }));
      const results = names.map((name) =>
        makeResult({
          name,
          task: name,
          exitCode: -1,
          startedAt: stoppedAt - 10,
          sessionDir: name === f.name ? f.sessionDir : "/workers/unaffected",
          budget: f.budget,
        }),
      );
      const details = Object.assign(buildSubagentDetails("parallel", "spawn", null, results), {
        asyncJobId: "nested-launch",
      });
      const identityEntries =
        identity === "persisted"
          ? [
              customEntry(SUBAGENT_NAMES_CUSTOM_TYPE, {
                namesFile: f.state.currentNamesFile,
                ownerId: "remote-parent-session",
              }),
            ]
          : [];
      const entries = [
        ...identityEntries,
        assistantSubagentCall("nested-launch", tasks),
        subagentToolResult("nested-launch", details, false),
      ];
      const recover = (history: SessionEntry[]): ReturnType<typeof findLatestResumableSubagentCalls> => {
        if (identity === "persisted") return findLatestResumableSubagentCalls(makeCtx(history));
        // Inheritance is captured at module load. A fresh process must receive the
        // registry in its startup environment, just as a resumed child worker does.
        const script = `
          const {findLatestResumableSubagentCalls} = await import(${JSON.stringify(new URL("../resume.ts", import.meta.url).href)});
          const {makeCtx} = await import(${JSON.stringify(new URL("./fixtures/resume.ts", import.meta.url).href)});
          console.log(JSON.stringify(findLatestResumableSubagentCalls(makeCtx(JSON.parse(process.argv[1])))));
        `;
        const child = spawnSync(
          process.execPath,
          ["--import", "tsx/esm", "--input-type=module", "-e", script, JSON.stringify(history)],
          {
            env: { ...process.env, [SUBAGENT_NAMES_FILE_ENV]: f.state.currentNamesFile },
            encoding: "utf8",
            timeout: 10000,
          },
        );
        assert.equal(child.status, 0, child.stderr);
        return JSON.parse(child.stdout);
      };
      const plans = recover(entries);
      assert.deepEqual(
        plans.flatMap((plan) => plan.details?.results.map((worker) => worker.name) ?? []),
        ["Unaffected-child"],
      );
      assert.deepEqual(plans[0].tasks, [tasks[1]], "remaining tasks and results must stay aligned");
      assert.deepEqual(readBudget(f.budget), budget, "recovery filtering must not refund descendant spending");
      assert.equal(readNamesRegistry(f.state.currentNamesFile).agents[f.name].stoppedAt, stoppedAt);

      const resumed = makeResult({ ...results[0], startedAt: stoppedAt + 1 });
      const resumedDetails = Object.assign(buildSubagentDetails("parallel", "spawn", null, [resumed]), {
        asyncJobId: "explicit-new-run",
      });
      const fresh = [
        ...identityEntries,
        assistantSubagentCall("explicit-new-run", [tasks[0]]),
        subagentToolResult("explicit-new-run", resumedDetails, false),
      ];
      assert.deepEqual(
        recover(fresh).flatMap((plan) => plan.details?.results.map((worker) => worker.name) ?? []),
        [f.name],
        "a genuinely new explicit run after the stop may recover without erasing the historical marker",
      );
    } finally {
      await f.close();
    }
  });
}
