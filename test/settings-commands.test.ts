import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { readBudget, reserveSubagentBudgets, SUBAGENT_BUDGET_CUSTOM_TYPE } from "../budget.js";
import { configuredEnv } from "../settings.js";
import { createExtensionHarness, hostDouble } from "./helpers/extension.js";
import { settingsFixture } from "./helpers/settings.js";

function setup(overrides: Record<string, unknown> = {}) {
  const f = settingsFixture();
  f.write(f.agent, { resume: { disableAuto: true }, ...overrides });
  process.env.PI_SUBAGENT_SESSION_ROOT = path.join(f.root, "sessions");
  const host = createExtensionHarness();
  const entries: SessionEntry[] = [];
  const notifications: string[] = [];
  const selections: string[] = [];
  const base = host.makeCtx(entries, { cwd: f.project });
  const ctx = hostDouble<ExtensionCommandContext>({
    ...base,
    ui: {
      ...base.ui,
      notify: (text: string) => {
        notifications.push(text);
      },
      select: async (title: string) => {
        selections.push(title);
        return "project";
      },
    },
  });
  return {
    f,
    host,
    entries,
    ctx,
    notifications,
    selections,
    async command(name: string, args = "") {
      const command = host.commands.get(`subagent:${name}`);
      assert.ok(command, name);
      await command.handler(args, ctx);
    },
  };
}

test("settings commands are session-only, override startup env and reset on the next session", async () => {
  const s = setup();
  try {
    process.env.PI_SUBAGENT_MAX_TASKS_PER_CALL = "12";
    await s.host.emit("session_start", {}, s.ctx);
    await s.command("max-tasks-per-call", "2");
    const prompt = (await s.host.emit("before_agent_start", {}, s.ctx)).at(-1) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Maximum tasks per call: 2/);
    assert.equal(process.env.PI_SUBAGENT_MAX_TASKS_PER_CALL, "12");
    assert.equal(fs.existsSync(path.join(s.f.project, ".pi")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.f.agent, "pi-subagent.json"), "utf8")).limits, undefined);
    await s.command("max-tasks-per-call");
    assert.match(s.notifications.at(-1)!, /^max-tasks-per-call: 2\n/);
    assert.match(s.notifications.at(-1)!, /single launch/);
    await s.host.emit("session_start", {}, s.ctx);
    const reset = (await s.host.emit("before_agent_start", {}, s.ctx)).at(-1) as { systemPrompt: string };
    assert.match(reset.systemPrompt, /Maximum tasks per call: 12/);
    await s.host.emit("session_shutdown", {}, s.ctx);
  } finally {
    s.f.close();
  }
});

test("enable initializes launch and messaging tools when the extension starts disabled", async () => {
  const s = setup({ extension: { disabled: true } });
  try {
    await s.host.emit("session_start", {}, s.ctx);
    assert.ok(!s.host.getActiveTools().includes("subagents"));
    assert.ok(!s.host.getActiveTools().includes("message_subagent"));
    await s.command("enable");
    assert.ok(s.host.getActiveTools().includes("subagents"));
    assert.ok(s.host.getActiveTools().includes("message_subagent"));
    await s.command("disable");
    assert.ok(!s.host.getActiveTools().includes("subagents"));
    assert.ok(!s.host.getActiveTools().includes("message_subagent"));
    const result = await s.host.call(
      "subagents",
      "blocked",
      { tasks: [{ task: "work", max_subagents_allowed: 0 }] },
      s.ctx,
    );
    assert.match(JSON.stringify(result.content), /delegation is disabled/);
    await s.command("enable");
    assert.ok(s.host.getActiveTools().includes("message_subagent"));
    await s.host.emit("session_shutdown", {}, s.ctx);
  } finally {
    s.f.close();
  }
});

test("intelligence command refreshes schemas from presets disabled by startup config", async () => {
  const s = setup({
    models: { intelligence: false },
    "subagents-models": [
      { cheap: { model: "small", provider: "local", "reasoning-level": "off" } },
      { costly: { model: "large", provider: "local", "reasoning-level": "high" } },
    ],
  });
  try {
    await s.host.emit("session_start", {}, s.ctx);
    const task = { task: "work", max_subagents_allowed: 0, intelligence: "cheap" };
    await s.command("intelligence", "on");
    assert.equal(Value.Check(s.host.tool("subagents").parameters as unknown as TSchema, { tasks: [task] }), true);
    await s.command("intelligence", "off");
    assert.equal(Value.Check(s.host.tool("subagents").parameters as unknown as TSchema, { tasks: [task] }), false);
    await s.host.emit("session_shutdown", {}, s.ctx);
  } finally {
    s.f.close();
  }
});

test("budget command updates effective allowance without resetting reservations or saving a default", async () => {
  const s = setup({ limits: { total: 5 } });
  try {
    await s.host.emit("session_start", {}, s.ctx);
    await s.host.emit("before_agent_start", {}, s.ctx);
    const entry = s.entries.find(
      (entry) => entry.type === "custom" && entry.customType === SUBAGENT_BUDGET_CUSTOM_TYPE,
    );
    assert.ok(entry?.type === "custom");
    const budget = entry.data as { directory: string };
    reserveSubagentBudgets(budget, "spent", [{ agent: "worker", task: "work", max_subagents_allowed: 1 }]);
    await s.command("max-total", "9");
    assert.deepEqual(readBudget(budget), { limit: 9, remaining: 7 });
    await s.command("max-total", "1");
    assert.match(s.notifications.at(-1)!, /spent|reserved|allocated/i);
    assert.deepEqual(readBudget(budget), { limit: 9, remaining: 7 });
    await s.host.emit("session_start", {}, s.ctx);
    assert.deepEqual(readBudget(budget), { limit: 5, remaining: 3 });
    await s.host.emit("session_shutdown", {}, s.ctx);
  } finally {
    s.f.close();
  }
});

test("save-settings prompts for scope and saves only command overrides", async () => {
  const s = setup({ runner: { startupRetries: 7 } });
  try {
    await s.host.emit("session_start", {}, s.ctx);
    await s.command("max-concurency", "3");
    await s.command("max-tasks-per-call", "12");
    await s.command("prevent-cycles", "off");
    await s.command("save-settings");
    assert.equal(s.selections.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(s.f.project, ".pi/pi-subagent.json"), "utf8"));
    assert.deepEqual(saved, { limits: { concurrency: 3, tasksPerCall: 12 }, delegation: { preventCycles: false } });
    await s.command("save-settings", "global");
    const global = JSON.parse(fs.readFileSync(path.join(s.f.agent, "pi-subagent.json"), "utf8"));
    assert.equal(global.runner.startupRetries, 7);
    assert.equal(global.limits.concurrency, 3);
    assert.equal(global.limits.tasksPerCall, 12);
    await s.host.emit("session_shutdown", {}, s.ctx);
  } finally {
    s.f.close();
  }
});

test("commands before budget initialization do not persist temporary grants", async () => {
  const s = setup({ limits: { total: 5 } });
  try {
    await s.host.emit("session_start", {}, s.ctx);
    s.ctx.isIdle = () => false;
    await s.command("max-total", "12");
    await s.host.emit("before_agent_start", {}, s.ctx);
    const entry = s.entries.find(
      (entry) => entry.type === "custom" && entry.customType === SUBAGENT_BUDGET_CUSTOM_TYPE,
    );
    assert.ok(entry?.type === "custom");
    const budget = entry.data as { directory: string };
    assert.deepEqual(readBudget(budget), { limit: 12, remaining: 12 });
    await s.host.emit("session_start", {}, s.ctx);
    assert.deepEqual(readBudget(budget), { limit: 5, remaining: 5 });
    await s.host.emit("session_shutdown", {}, s.ctx);
  } finally {
    s.f.close();
  }
});

test("unrelated commands preserve invalid-env batch fallback and save cancellation writes nothing", async () => {
  const s = setup();
  try {
    process.env.PI_SUBAGENT_MAX_TASKS_PER_CALL = "invalid";
    await s.host.emit("session_start", {}, s.ctx);
    await s.command("prevent-cycles", "off");
    const prompt = (await s.host.emit("before_agent_start", {}, s.ctx)).at(-1) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Maximum tasks per call: 20/);
    const cancel = s.host.commands.get("subagent:save-settings")!;
    await cancel.handler(
      "",
      hostDouble<ExtensionCommandContext>({ ...s.ctx, ui: { ...s.ctx.ui, select: async () => undefined } }),
    );
    assert.equal(fs.existsSync(path.join(s.f.project, ".pi")), false);
    await s.host.emit("session_shutdown", {}, s.ctx);
  } finally {
    s.f.close();
  }
});

test("the user can change live concurrency and budget limits while the main agent is busy", async () => {
  const s = setup({ limits: { concurrency: 1, total: 5 } });
  try {
    await s.host.emit("session_start", {}, s.ctx);
    await s.host.emit("before_agent_start", {}, s.ctx);
    const originalTool = s.host.tool("subagents");
    s.ctx.isIdle = () => false;
    for (const limit of [4, 2]) {
      await s.command("max-concurency", String(limit));
      assert.doesNotMatch(s.notifications.at(-1)!, /Wait for the current/);
      const prompt = (await s.host.emit("before_agent_start", {}, s.ctx)).at(-1) as { systemPrompt: string };
      assert.match(prompt.systemPrompt, new RegExp(`Global live-worker limit across the entire nested tree: ${limit}`));
      assert.equal(s.host.tool("subagents"), originalTool, "a cap change must not re-register tools mid-turn");
    }
    const entry = s.entries.find(
      (entry) => entry.type === "custom" && entry.customType === SUBAGENT_BUDGET_CUSTOM_TYPE,
    );
    assert.ok(entry?.type === "custom");
    const budget = entry.data as { directory: string };
    reserveSubagentBudgets(budget, "spent", [{ agent: "worker", task: "work", max_subagents_allowed: 1 }]);
    await s.command("max-total", "200");
    assert.deepEqual(readBudget(budget), { limit: 200, remaining: 198 });
    assert.equal(s.host.tool("subagents"), originalTool);
    await s.command("max-total", "1");
    assert.match(s.notifications.at(-1)!, /spent|reserved/);
    assert.deepEqual(readBudget(budget), { limit: 200, remaining: 198 });
    const saved = JSON.parse(fs.readFileSync(path.join(s.f.agent, "pi-subagent.json"), "utf8"));
    assert.deepEqual(saved.limits, { concurrency: 1, total: 5 });
    await s.host.emit("session_shutdown", {}, s.ctx);
  } finally {
    s.f.close();
  }
});

test("validation, inspection and child restrictions leave settings untouched", async () => {
  const s = setup();
  try {
    await s.host.emit("session_start", {}, s.ctx);
    for (const [name, value] of [
      ["max-total", "-1"],
      ["max-depth", "1.5"],
      ["max-tasks-per-call", "0"],
      ["max-concurency", "0"],
      ["auto-resume", "maybe"],
      ["confirm-project", "yes"],
    ]) {
      await s.command(name, value);
      assert.doesNotMatch(s.notifications.at(-1)!, /Session only/);
    }
    assert.equal(s.host.commands.has("subagent:fallback-model"), false);
    assert.equal(s.host.commands.has("subagent:resume"), false);
    assert.equal(s.host.commands.has("subagent:concurrency"), false);
    assert.equal(s.host.commands.has("subagent:max-parallel"), false);
    assert.equal(s.host.commands.has("subagent:max-concurrent-per-call"), false);
    await s.command("max-tasks-per-call");
    assert.match(s.notifications.at(-1)!, /^max-tasks-per-call: 20\n/);
    await s.command("max-concurency");
    assert.match(s.notifications.at(-1)!, /^max-concurency: 8\n/);
    assert.match(s.host.commands.get("subagent:max-concurency")!.description!, /session/i);
    await s.command("settings");
    assert.match(s.notifications.at(-1)!, /subagent:max-total/);
    assert.doesNotMatch(s.notifications.at(-1)!, /fallback-model|subagent:resume(?:\s|$)/);
    assert.match(s.notifications.at(-1)!, /subagent:auto-resume/);
    assert.match(s.notifications.at(-1)!, /subagent:resume-prompt/);
    await s.command("resume-prompt");
    assert.match(s.notifications.at(-1)!, /off continues without asking, not without recovery/);
    await s.command("confirm-project");
    assert.match(s.notifications.at(-1)!, /it does not block them/);
    const completions = await s.host.commands.get("subagent:confirm-project")!.getArgumentCompletions!("never");
    assert.match(completions![0].description!, /it does not block them/);
    await s.command("save-settings", "global");
    assert.match(s.notifications.at(-1)!, /No session setting changes/);
    await s.host.emit("session_shutdown", {}, s.ctx);
    process.env.PI_SUBAGENT_DEPTH = "1";
    const child = createExtensionHarness();
    const childCtx = child.makeCtx([], { cwd: s.f.project });
    await child.emit("session_start", {}, childCtx);
    const notices: string[] = [];
    await child.commands.get("subagent:max-depth")!.handler(
      "99",
      hostDouble<ExtensionCommandContext>({
        ...childCtx,
        ui: {
          ...childCtx.ui,
          notify: (text: string) => {
            notices.push(text);
          },
        },
      }),
    );
    assert.match(notices.at(-1)!, /inherited grant/);
    await child.emit("session_shutdown", {}, childCtx);
    assert.equal(configuredEnv("PI_SUBAGENT_MAX_DEPTH", {}), undefined);
  } finally {
    s.f.close();
  }
});
