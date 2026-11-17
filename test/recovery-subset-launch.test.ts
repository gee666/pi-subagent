import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents.js";
import { createBudget, readBudget, reservedSubagentBudgets, reserveSubagentBudgets } from "../budget.js";
import { allocateSubagentNames } from "../names.js";
import { buildSubagentSessionDir, type ResumableSubagentCall } from "../resume.js";
import { buildSubagentDetails, isSubagentDetails, type SingleResult } from "../types.js";
import { registerSubagentsTool } from "../extension/launch-tool.js";
import { createExtensionState } from "../extension/state.js";
import { createExtensionHarness, hostDouble } from "./helpers/extension.js";
import { makeResult } from "./helpers/results.js";
import { settingsFixture } from "./helpers/settings.js";

const launchTasks = ["first", "second", "third"].map((task) => ({ agent: "worker", task, max_subagents_allowed: 1 }));

// Recovery plans hold only interrupted workers. They must keep the original
// launch's grants and slot session directories rather than re-reserving.
test("subset recovery keeps original grants and slot session dirs, also when recovered again", async () => {
  const f = settingsFixture();
  const log = path.join(f.root, "launches.jsonl");
  const script = path.join(f.root, "fake-pi.cjs");
  fs.writeFileSync(
    script,
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      if (JSON.parse(line).type !== 'prompt') return;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    });
  `,
  );
  f.write(f.agent, { runner: { command: process.execPath, argsPrefix: [script] }, agents: { confirmProject: false } });
  try {
    let tool: ToolDefinition | undefined;
    const completions: SingleResult[] = [];
    const pi = hostDouble<ExtensionAPI>({
      getFlag: () => undefined,
      sendMessage(message) {
        if (isSubagentDetails(message.details)) completions.push(...message.details.results);
      },
      registerTool(registered) {
        tool = registered as unknown as ToolDefinition;
      },
    });
    const state = createExtensionState(pi);
    state.sessionActive = true;
    state.discoveredAgents = discoverAgents(f.project, "both").agents;
    state.currentSessionId = "parent";
    state.currentSubagentSessionRoot = path.join(f.root, "sessions");
    state.currentNamesFile = path.join(f.root, "names.json");
    state.currentOwnerId = "root";
    state.currentBudget = createBudget(path.join(f.root, "budget"), 10);
    const grants = reserveSubagentBudgets(state.currentBudget, "original", launchTasks, "main");
    const remaining = readBudget(state.currentBudget).remaining;
    const slotDir = (index: number) =>
      buildSubagentSessionDir(state.currentSubagentSessionRoot, "parent", "original", index);

    // Slot 1 has a receipt; slot 2 never got one, so only its launch index locates its session.
    fs.mkdirSync(slotDir(1), { recursive: true });
    fs.writeFileSync(path.join(slotDir(1), "session.jsonl"), JSON.stringify({ type: "session", id: "w1" }) + "\n");
    const [name] = await allocateSubagentNames(state.currentNamesFile, "root", [
      { agent: "worker", task: "second", sessionDir: slotDir(1), budget: grants[1] },
    ]);
    const receipt = makeResult({
      agent: "worker",
      task: "second",
      exitCode: -1,
      name,
      sessionDir: slotDir(1),
      budget: grants[1],
    });
    const unstarted = makeResult({ agent: "worker", task: "third", exitCode: -1 });
    const plan: ResumableSubagentCall = {
      previousToolCallId: "original",
      tasks: launchTasks.slice(1),
      taskIndexes: [1, 2],
      details: buildSubagentDetails("parallel", "spawn", null, [receipt, unstarted]),
    };
    const ctx = createExtensionHarness().makeCtx([], { cwd: f.project, hasUI: false, isProjectTrusted: () => true });
    state.latestSessionCtx = ctx;
    registerSubagentsTool(state);
    assert.ok(tool);

    const recover = async (callId: string, recoveryPlan: ResumableSubagentCall, expected: number) => {
      state.pendingResumePlans = [recoveryPlan];
      state.recoveryPlansByToolCallId = new Map([[callId, recoveryPlan]]);
      const result = await tool!.execute(callId, { tasks: recoveryPlan.tasks }, undefined, undefined, ctx);
      assert.notEqual("isError" in result && result.isError, true, JSON.stringify(result.content));
      assert.ok(isSubagentDetails(result.details));
      await Promise.all([...state.backgroundJobs.values()].map((job) => job.promise));
      const deadline = Date.now() + 10000;
      while (completions.length < expected && Date.now() < deadline) await delay(10);
      assert.equal(reservedSubagentBudgets(state.currentBudget!, callId), undefined, "no fresh reservation");
      assert.equal(readBudget(state.currentBudget!).remaining, remaining, "recovery does not charge again");
      return result.details.results;
    };

    const first = await recover("recovery-1", plan, 2);
    assert.deepEqual(
      first.map((result) => [result.sessionDir, result.budget]),
      [
        [slotDir(1), grants[1]],
        [slotDir(2), grants[2]],
      ],
    );
    assert.deepEqual(
      completions
        .map((result) => [result.sessionDir, result.budget?.directory, result.exitCode])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      [
        [slotDir(1), grants[1].directory, 0],
        [slotDir(2), grants[2].directory, 0],
      ],
    );

    // A recovery of that recovery still uses the original launch identity.
    completions.length = 0;
    const again: ResumableSubagentCall = {
      previousToolCallId: "original",
      tasks: [launchTasks[2]],
      taskIndexes: [2],
      details: buildSubagentDetails("single", "spawn", null, [first[1]]),
    };
    const second = await recover("recovery-2", again, 1);
    assert.deepEqual(
      second.map((result) => [result.sessionDir, result.budget]),
      [[slotDir(2), grants[2]]],
    );
    assert.equal(completions[0]?.sessionDir, slotDir(2));

    const sessions = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const args = JSON.parse(line) as string[];
        return args[args.indexOf("--session-dir") + 1];
      })
      .sort();
    assert.deepEqual(sessions, [slotDir(1), slotDir(2), slotDir(2)].sort());
  } finally {
    f.close();
  }
});
