import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { createBudget, overrideResumeBudgets, reserveSubagentBudgets } from "../budget.js";
import { createExtensionHarness } from "./helpers/extension.js";
import { settingsFixture } from "./helpers/settings.js";
import { simulatedTreeWorker } from "./helpers/tree-concurrency.js";

test("a running leaf gains delegation tools when its lead increases its allowance", async () => {
  const f = settingsFixture();
  const host = createExtensionHarness();
  const tree = simulatedTreeWorker(path.join(f.root, "concurrency"));
  try {
    const parent = createBudget(path.join(f.root, "parent"), 3);
    const [child] = reserveSubagentBudgets(
      parent,
      "launch",
      [{ agent: "", task: "work", max_subagents_allowed: 0 }],
      "main",
    );
    Object.assign(process.env, tree.env);
    process.env.PI_SUBAGENT_DEPTH = "1";
    process.env.PI_SUBAGENT_MAX_DEPTH = "3";
    process.env.PI_SUBAGENT_BUDGET_DIR = child.directory;
    const ctx = host.makeCtx([], { cwd: f.project, isProjectTrusted: () => true });
    await host.emit("session_start", {}, ctx);
    assert.equal(host.getActiveTools().includes("subagents"), false);
    assert.equal(host.getActiveTools().includes("message_lead_agent"), true);
    overrideResumeBudgets(parent, [{ budget: child, max_subagents_allowed: 1 }], "main");
    await host.emit("input", { text: "You can delegate now.", source: "rpc" }, ctx);
    assert.equal(host.getActiveTools().includes("subagents"), true);
    assert.equal(host.getActiveTools().includes("message_subagent"), true);
    const prompt = (await host.emit("before_agent_start", {}, ctx)).at(-1) as { systemPrompt: string };
    assert.doesNotMatch(prompt.systemPrompt, /Session budget is not initialized/);
    assert.match(prompt.systemPrompt, /message_subagent/);
    await host.emit("session_shutdown", {}, ctx);
  } finally {
    tree.close();
    f.close();
  }
});
