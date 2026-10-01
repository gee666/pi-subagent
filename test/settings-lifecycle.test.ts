import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createBudget, readBudget, SUBAGENT_BUDGET_CUSTOM_TYPE } from "../budget.js";
import { resolveDelegationDepthConfig, getProjectAgentConfirmationSetting } from "../extension/policy.js";
import { readSettings } from "../settings.js";
import { getEnvFallbackModel } from "../extension/models.js";
import { createExtensionHarness, customEntry, hostDouble, resumeBranch } from "./helpers/extension.js";
import { settingsFixture } from "./helpers/settings.js";

test("project settings load after trust, refresh on session switches and can enable initially blocked delegation", async () => {
  const f = settingsFixture();
  try {
    f.write(f.agent, { delegation: { depth: 0 }, resume: { disableAuto: true } });
    f.write(path.join(f.project, ".pi"), {
      delegation: { depth: 3 },
      limits: { parallel: 1, total: 0 },
      agents: { hideBuiltins: true, confirmProject: "session" },
      models: { intelligence: true },
      "subagents-models": [
        { cheap: { model: "small", provider: "local", "reasoning-level": "off" } },
        { costly: { model: "large", provider: "local", "reasoning-level": "high" } },
      ],
    });
    const host = createExtensionHarness();
    const entries: SessionEntry[] = [];
    const untrusted = host.makeCtx(entries, { cwd: f.project, hasUI: false });
    await host.emit("session_start", {}, untrusted);
    assert.equal(host.tools.has("subagents"), false);
    const trusted = host.makeCtx(entries, { cwd: f.project, hasUI: false, isProjectTrusted: () => true });
    await host.emit("session_start", {}, trusted);
    assert.ok(host.getActiveTools().includes("subagents"));
    // Pi maps TypeBox versions at load time. This harness stores our local schema unchanged.
    const params = host.tool("subagents").parameters as unknown as TSchema;
    const task = { agent: "worker", task: "work", max_subagents_allowed: 0 };
    assert.equal(Value.Check(params, { tasks: [task] }), false);
    assert.equal(Value.Check(params, { tasks: [{ ...task, intelligence: "cheap" }] }), true);
    const prompt = (await host.emit("before_agent_start", {}, trusted)).at(-1) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Technical batch capacity: 1/);
    assert.match(prompt.systemPrompt, /You cannot launch subagents/);
    assert.match(prompt.systemPrompt, /No agents are available/);
    const budgetEntry = entries.find(
      (entry) => entry.type === "custom" && entry.customType === SUBAGENT_BUDGET_CUSTOM_TYPE,
    );
    assert.ok(budgetEntry?.type === "custom");
    assert.equal(readBudget(budgetEntry.data as { directory: string }).limit, 0);
    f.write(path.join(f.project, ".pi"), {
      delegation: { depth: 3 },
      limits: { total: 99 },
      resume: { disabled: true },
    });
    await host.emit("session_start", {}, trusted);
    assert.equal(host.getActiveTools().includes("resume_subagents"), false);
    await host.emit("before_agent_start", {}, trusted);
    assert.equal(readBudget(budgetEntry.data as { directory: string }).limit, 0, "existing allowance never resets");
    f.write(path.join(f.project, ".pi"), { delegation: { depth: 3 }, resume: { disabled: false } });
    await host.emit("session_start", {}, trusted);
    assert.ok(host.getActiveTools().includes("resume_subagents"));
    await host.emit("session_start", {}, untrusted);
    assert.equal(host.getActiveTools().includes("subagents"), false);
    const result = await host.call("subagents", "disabled", { tasks: [task] }, untrusted);
    assert.match(JSON.stringify(result.content), /delegation is disabled/);
    await host.emit("session_shutdown", {}, trusted);
  } finally {
    f.close();
  }
});

test("disabled setting respects startup env precedence and trusted project disabling", async () => {
  const f = settingsFixture();
  try {
    f.write(f.agent, { extension: { disabled: true } });
    assert.equal(createExtensionHarness().tools.size, 0);
    process.env.PI_SUBAGENT_DISABLED = "false";
    assert.ok(createExtensionHarness().tools.has("subagents"));
    delete process.env.PI_SUBAGENT_DISABLED;
    f.write(f.agent, { extension: { disabled: false } });
    f.write(path.join(f.project, ".pi"), { extension: { disabled: true } });
    const host = createExtensionHarness();
    const ctx = host.makeCtx([], { cwd: f.project, isProjectTrusted: () => true });
    await host.emit("session_start", {}, ctx);
    assert.equal(host.getActiveTools().includes("subagents"), false);
    assert.equal(host.getActiveTools().includes("resume_subagents"), false);
    await host.emit("session_shutdown", {}, ctx);
  } finally {
    f.close();
  }
});

test("trusted project JSON can re-enable a personally disabled extension but env disables remain final", async () => {
  const f = settingsFixture();
  try {
    f.write(f.agent, { extension: { disabled: true }, resume: { disableAuto: true } });
    f.write(path.join(f.project, ".pi"), { extension: { disabled: false } }, "pi-subagents.json");
    const host = createExtensionHarness();
    assert.equal(host.tools.size, 0);
    const entries: SessionEntry[] = [];
    const untrusted = host.makeCtx(entries, { cwd: f.project, hasUI: false });
    await host.emit("session_start", {}, untrusted);
    assert.equal(host.tools.size, 0);
    const trusted = host.makeCtx(entries, { cwd: f.project, hasUI: false, isProjectTrusted: () => true });
    await host.emit("session_start", {}, trusted);
    assert.ok(host.getActiveTools().includes("subagents"));
    assert.ok(host.getActiveTools().includes("resume_subagents"));
    const prompt = (await host.emit("before_agent_start", {}, trusted)).at(-1) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Available Subagents/);
    await host.emit("session_start", {}, untrusted);
    assert.equal(host.getActiveTools().includes("subagents"), false);
    await host.emit("session_start", {}, trusted);
    assert.ok(host.getActiveTools().includes("subagents"));
    await host.emit("session_shutdown", {}, trusted);
    for (const key of ["PI_SUBAGENT_DISABLED", "PI-SUBAGENT-DISABLED"]) {
      process.env[key] = "true";
      const disabled = createExtensionHarness();
      const ctx = disabled.makeCtx([], { cwd: f.project, isProjectTrusted: () => true });
      await disabled.emit("session_start", {}, ctx);
      assert.equal(disabled.tools.size, 0);
      delete process.env[key];
    }
  } finally {
    f.close();
  }
});

test("JSON cannot loosen child depth/cycle grants or replace a child's zero branch allowance", async () => {
  const f = settingsFixture();
  try {
    const raw = { delegation: { depth: 100, preventCycles: false }, limits: { total: 100 } };
    const settings = readSettings(raw, "test");
    Object.assign(process.env, {
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_MAX_DEPTH: "1",
      PI_SUBAGENT_PREVENT_CYCLES: "1",
      PI_SUBAGENT_STACK: '["worker"]',
    });
    const pi = hostDouble<ExtensionAPI>({ getFlag: (name) => (name === "subagent-max-depth" ? "100" : false) });
    const depth = resolveDelegationDepthConfig(pi, settings);
    assert.equal(depth.maxDepth, 1);
    assert.equal(depth.canDelegate, false);
    assert.equal(depth.preventCycles, true);
    assert.deepEqual(depth.ancestorAgentStack, ["worker"]);
    process.env.PI_SUBAGENT_MAX_DEPTH = "3";
    const budget = createBudget(path.join(f.root, "private-budget"), 0);
    process.env.PI_SUBAGENT_BUDGET_DIR = budget.directory;
    f.write(path.join(f.project, ".pi"), raw);
    const host = createExtensionHarness();
    const ctx = host.makeCtx([customEntry(SUBAGENT_BUDGET_CUSTOM_TYPE, budget)], {
      cwd: f.project,
      isProjectTrusted: () => true,
    });
    await host.emit("session_start", {}, ctx);
    assert.equal(host.getActiveTools().includes("subagents"), false);
    assert.deepEqual(readBudget(budget), { limit: 0, remaining: 0 });
    await host.emit("session_shutdown", {}, ctx);
  } finally {
    f.close();
  }
});

test("resume prompt and automatic-resume switches apply to lifecycle handlers with env priority", async () => {
  const f = settingsFixture();
  try {
    f.write(f.agent, { resume: { disableAuto: true, prompt: false } });
    const host = createExtensionHarness();
    const ctx = host.makeCtx(resumeBranch(), { cwd: f.project });
    await host.emit("session_start", { reason: "resume" }, ctx);
    await host.emit("session_tree", {}, ctx);
    assert.equal(host.calls.confirms, 0);
    assert.equal(host.calls.setModel.length, 0);
    process.env.PI_SUBAGENT_DISABLE_RESUME = "false";
    process.env.PI_SUBAGENT_RESUME_PROMPT = "true";
    await host.emit("session_start", { reason: "resume" }, ctx);
    assert.equal(host.calls.confirms, 1);
    await host.emit("session_shutdown", {}, ctx);
    delete process.env.PI_SUBAGENT_RESUME_PROMPT;
    const automatic = createExtensionHarness();
    const automaticCtx = automatic.makeCtx(resumeBranch(), { cwd: f.project });
    await automatic.emit("session_start", { reason: "resume" }, automaticCtx);
    assert.equal(automatic.calls.confirms, 0);
    assert.ok(automatic.calls.setModel.length);
    await automatic.emit("session_shutdown", {}, automaticCtx);
  } finally {
    f.close();
  }
});

test("resume env changes refresh registration and activation on the next session", async () => {
  const f = settingsFixture();
  try {
    process.env.DISABLE_RESUMABLE_SUBAGENTS = "true";
    const host = createExtensionHarness();
    assert.equal(host.tools.has("resume_subagents"), false);
    const ctx = host.makeCtx([], { cwd: f.project, hasUI: false });
    await host.emit("session_start", {}, ctx);
    process.env.DISABLE_RESUMABLE_SUBAGENTS = "false";
    await host.emit("session_start", {}, ctx);
    assert.ok(host.getActiveTools().includes("resume_subagents"));
    process.env.DISABLE_RESUMABLE_SUBAGENTS = "true";
    await host.emit("session_start", {}, ctx);
    assert.equal(host.getActiveTools().includes("resume_subagents"), false);
    process.env.DISABLE_RESUMABLE_SUBAGENTS = "false";
    await host.emit("session_start", {}, ctx);
    assert.ok(host.getActiveTools().includes("resume_subagents"));
    await host.emit("session_shutdown", {}, ctx);
  } finally {
    f.close();
  }
});

test("project-agent confirmation and synthetic fallback-model helpers use the settings snapshot", () => {
  const f = settingsFixture();
  try {
    const settings = readSettings(
      { agents: { confirmProject: "session" }, models: { fallback: "local/small" } },
      "test",
    );
    assert.equal(getProjectAgentConfirmationSetting(settings), "session");
    process.env.PI_SUBAGENT_CONFIRM_PROJECT_AGENTS = "true";
    assert.equal(getProjectAgentConfirmationSetting(settings), "ask");
    const host = createExtensionHarness();
    const ctx = host.makeCtx([]);
    assert.equal(getEnvFallbackModel(ctx, settings)?.id, "small");
    process.env.PI_SUBAGENT_FALLBACK_MODEL = "other/large";
    assert.equal(getEnvFallbackModel(ctx, settings)?.id, "large");
  } finally {
    f.close();
  }
});
