import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeContext, validateToolArguments, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../agents.js";
import { createBudget, readBudget, reserveSubagentBudgets } from "../budget.js";
import { allocateSubagentNames } from "../names.js";
import type { ResumableSubagentCall } from "../resume.js";
import { buildSubagentDetails, isSubagentDetails } from "../types.js";
import { registerSubagentsTool } from "../extension/launch-tool.js";
import { registerResumeProvider } from "../extension/provider.js";
import { findRecoveryPlanIndex, getPreparedRecoveryPlan, prepareRecoveryArguments } from "../extension/schemas.js";
import { createExtensionState } from "../extension/state.js";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";
import { createExtensionHarness, hostDouble, model } from "./helpers/extension.js";
import { makeResult } from "./helpers/results.js";
import { settingsFixture } from "./helpers/settings.js";

for (const [customTypesAvailable, hiddenIntelligence] of [
  [false, false],
  [true, false],
  [false, true],
]) {
  test(`historical recovery preserves B's identity when B runs first, custom types ${customTypesAvailable}, hidden intelligence ${hiddenIntelligence}`, async () => {
    const f = settingsFixture();
    const log = path.join(f.root, "launches.jsonl");
    const script = path.join(f.root, "fake-pi.cjs");
    fs.writeFileSync(
      script,
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.type !== 'prompt') return;
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt: request.message }) + '\\n');
        console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
          content: [{ type: 'text', text: 'recovered' }], stopReason: 'stop' } }));
        console.log(JSON.stringify({ type: 'agent_settled' }));
      });
    `,
    );
    f.write(f.agent, {
      runner: { command: process.execPath, argsPrefix: [script] },
      agents: { confirmProject: false },
    });
    if (customTypesAvailable) {
      const dir = path.join(f.project, ".pi/agents");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "custom.md"), "---\nname: custom\ndescription: custom agent\n---\nCUSTOM ROLE.");
    }
    try {
      let tool: ToolDefinition | undefined;
      let provider: Provider | undefined;
      const pi = hostDouble<ExtensionAPI>({
        getFlag: () => undefined,
        registerTool(registered) {
          tool = registered as unknown as ToolDefinition;
        },
        registerProvider(registered) {
          assert.notEqual(typeof registered, "string");
          if (typeof registered !== "string") provider = registered;
        },
      });
      const state = createExtensionState(pi);
      state.sessionActive = true;
      state.discoveredAgents = discoverAgents(f.project, "both").agents;
      state.currentSubagentSessionRoot = path.join(f.root, "sessions");
      state.currentNamesFile = path.join(f.root, "names.json");
      state.currentOwnerId = "root";
      state.currentBudget = createBudget(path.join(f.root, "budget"), 10);
      const plans: ResumableSubagentCall[] = [];
      // The two calls have identical task text and allowances, but different
      // hidden choices, sessions, names, and branch grants.
      const historicalTypes = hiddenIntelligence ? ["code-writer", "code-writer"] : ["code-writer", "code-architect"];
      for (const [index, agent] of historicalTypes.entries()) {
        const task = {
          agent,
          task: "same unfinished task",
          max_subagents_allowed: 0,
          ...(hiddenIntelligence ? { intelligence: `old-${index}` } : {}),
        };
        const previousToolCallId = `saved-${index}`;
        const budget = reserveSubagentBudgets(state.currentBudget, previousToolCallId, [task])[0];
        const sessionDir = path.join(f.root, `saved-session-${index}`);
        fs.mkdirSync(sessionDir);
        fs.writeFileSync(
          path.join(sessionDir, "session.jsonl"),
          JSON.stringify({
            type: "session",
            id: `worker-${index}`,
            cwd: f.project,
          }) + "\n",
        );
        const [name] = await allocateSubagentNames(state.currentNamesFile, "root", [
          {
            agent,
            task: task.task,
            sessionDir,
            budget,
          },
        ]);
        plans.push({
          previousToolCallId,
          tasks: [task],
          details: buildSubagentDetails("single", "spawn", null, [
            makeResult({
              agent,
              agentSource: "builtin",
              name,
              sessionDir,
              budget,
              task: task.task,
              exitCode: 130,
              stopReason: "aborted",
            }),
          ]),
        });
      }
      state.pendingResumePlans = [...plans];
      state.resumeState.trigger = "nextRequest";
      const ctx = createExtensionHarness().makeCtx([], {
        cwd: f.project,
        hasUI: false,
        isProjectTrusted: () => true,
      });
      state.latestSessionCtx = ctx;
      registerSubagentsTool(state);
      registerResumeProvider(state);
      assert.ok(tool?.prepareArguments);
      assert.ok(provider);
      const schemaText = JSON.stringify(tool.parameters);
      if (!customTypesAvailable) assert.equal(schemaText.includes('"agent"'), false);
      const message = await provider
        .streamSimple(
          model(RESUME_PROVIDER, RESUME_MODEL_ID, "openai-responses"),
          normalizeContext({ messages: [] }),
          {},
        )
        .result();
      const calls = message.content.filter((part) => part.type === "toolCall");
      assert.equal(calls.length, 2);
      // Preparing A and B yields identical public arguments when agent types
      // are hidden. Exact plan identity must survive Pi's validation clone.
      const prepared = calls.map((call) => tool!.prepareArguments!(call.arguments));
      if (!customTypesAvailable) {
        assert.deepEqual(prepared[0], prepared[1]);
        assert.equal(getPreparedRecoveryPlan(prepared[1] as object), hiddenIntelligence ? undefined : plans[1]);
      }
      const validated = prepared.map((args, index) =>
        validateToolArguments(tool!, {
          ...calls[index],
          arguments: args as (typeof calls)[number]["arguments"],
        }),
      );
      assert.equal(getPreparedRecoveryPlan(validated[1]), undefined, "SDK validation clones the public payload");
      for (const index of [1, 0]) {
        const result: Awaited<ReturnType<ToolDefinition["execute"]>> = await tool.execute(
          calls[index].id,
          validated[index],
          undefined,
          undefined,
          ctx,
        );
        assert.notEqual("isError" in result && result.isError, true, JSON.stringify(result.content));
        assert.ok(isSubagentDetails(result.details));
        const saved = plans[index].details!.results[0];
        const recovered = result.details.results[0];
        assert.equal(recovered.agent, saved.agent);
        assert.equal(recovered.name, saved.name);
        assert.equal(recovered.sessionDir, saved.sessionDir);
        assert.deepEqual(recovered.budget, saved.budget);
        assert.equal(readBudget(state.currentBudget).remaining, 8, "recovery reuses the original grants");
        assert.deepEqual(state.pendingResumePlans, index === 1 ? [plans[0]] : []);
      }
      const launches = fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; prompt: string });
      assert.equal(launches.length, 2);
      for (const [position, planIndex] of [1, 0].entries()) {
        const args = launches[position].args;
        assert.equal(
          args[args.indexOf("--session") + 1],
          path.join(plans[planIndex].details!.results[0].sessionDir!, "session.jsonl"),
        );
        assert.equal(
          args.includes("--append-system-prompt"),
          false,
          "missing historical definitions have no role prompt",
        );
      }
    } finally {
      f.close();
    }
  });
}

test("prepared historical recovery binds the exact plan without adding public fields", () => {
  const task = { task: "same", max_subagents_allowed: 0 };
  const plans = ["A", "B"].map((agent) => ({ previousToolCallId: agent, tasks: [{ ...task, agent }] }));
  const prepared = prepareRecoveryArguments({ tasks: plans[1].tasks }, plans, [], undefined, false);
  assert.deepEqual(prepared, { tasks: [task] });
  assert.equal(getPreparedRecoveryPlan(prepared as object), plans[1]);
  assert.deepEqual(Object.keys(prepared as object), ["tasks"]);
  assert.throws(() => findRecoveryPlanIndex([{ ...task, agent: "" }], plans, [], undefined, false), /Ambiguous/);
});
