import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createBudget, overrideResumeBudgets, reserveSubagentBudgets, SUBAGENT_BUDGET_CUSTOM_TYPE } from "../budget.js";
import { createExtensionHarness, customEntry } from "./helpers/extension.js";
import { isRecord } from "../extension/contracts.js";

test("zero-allowance workers hide tools and guidance, then regain them on resume", async () => {
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp", "budget-visibility-"));
  const variables = {
    PI_SUBAGENT_DEPTH: "1",
    PI_SUBAGENT_MAX_DEPTH: "3",
    PI_SUBAGENT_BUDGET_DIR: "",
    PI_SUBAGENT_DISABLE_RESUME: "true",
    DISABLE_RESUMABLE_SUBAGENTS: "false",
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  try {
    const parent = createBudget(path.join(dir, "budget"), 3);
    const task = { agent: "worker", task: "work", max_subagents_allowed: 0 };
    const [budget] = reserveSubagentBudgets(parent, "leaf", [task]);
    process.env.PI_SUBAGENT_BUDGET_DIR = budget.directory;
    const host = createExtensionHarness();
    const entries = [customEntry(SUBAGENT_BUDGET_CUSTOM_TYPE, budget)];
    const ctx = host.makeCtx(entries, { cwd: dir, hasUI: false });
    await host.emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual(host.getActiveTools(), ["read", "bash"]);
    const prompts = await host.emit("before_agent_start", { systemPrompt: "base" }, ctx);
    assert.ok(prompts.every((result) => result === undefined));

    overrideResumeBudgets(parent, [{ budget, max_subagents_allowed: 1 }]);
    // A production resume starts a fresh process with the persisted budget.
    const resumed = createExtensionHarness();
    const resumedCtx = resumed.makeCtx(entries, { cwd: dir, hasUI: false });
    await resumed.emit("session_start", { reason: "startup" }, resumedCtx);
    assert.ok(resumed.getActiveTools().includes("subagents"));
    assert.ok(resumed.getActiveTools().includes("resume_subagents"));
    const guidance = (await resumed.emit("before_agent_start", {}, resumedCtx)).at(-1);
    assert.ok(isRecord(guidance) && typeof guidance.systemPrompt === "string");
    assert.match(guidance.systemPrompt, /Available Subagents/);

    // The documented activation API also works in the same runtime.
    await host.emit("session_start", { reason: "resume" }, ctx);
    assert.ok(host.getActiveTools().includes("subagents"));
    assert.ok(host.getActiveTools().includes("resume_subagents"));

    // Spending a positive allowance must not remove access to existing children.
    reserveSubagentBudgets(budget, "child", [task]);
    await host.emit("session_start", { reason: "reload" }, ctx);
    assert.ok(host.getActiveTools().includes("resume_subagents"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
