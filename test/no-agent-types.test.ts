import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENT } from "../agents.js";
import { findPersistedBudget, readBudget } from "../budget.js";
import { parseIntelligencePresets } from "../intelligence.js";
import { findPersistedNamesIdentity, readNamesRegistry } from "../names.js";
import { findLatestResumableSubagentCalls } from "../resume.js";
import {
  createIntelligenceSchemas,
  findRecoveryPlanIndex,
  prepareRecoveryArguments,
  validatePreparedArguments,
} from "../extension/schemas.js";
import { createExtensionHarness, messageEntry, model } from "./helpers/extension.js";
import { settingsFixture } from "./helpers/settings.js";

const configured = [
  { cheap: { model: "small", provider: "local", "reasoning-level": "off" } },
  { costly: { model: "large", provider: "local", "reasoning-level": "high" } },
];

test("agent and intelligence launch fields are independent choices", () => {
  const f = settingsFixture();
  try {
    const presets = parseIntelligencePresets(configured);
    for (const hasAgentTypes of [false, true]) {
      for (const choices of [[], presets.slice(0, 1), presets]) {
        for (const enabled of [false, true]) {
          process.env.PI_SUBAGENT_INTELLIGENCE = String(enabled);
          const schema = createIntelligenceSchemas(choices, undefined, hasAgentTypes).subagents;
          const fields = schema.properties.tasks.items.properties;
          const hasIntelligence = enabled && choices.length >= 2;
          assert.deepEqual(Object.keys(fields).sort(), [
            ...(hasAgentTypes ? ["agent"] : []),
            ...(hasIntelligence ? ["intelligence"] : []),
            "max_subagents_allowed",
            "task",
          ]);
          assert.equal(schema.properties.tasks.items.additionalProperties, false);
          const task = {
            task: "work",
            max_subagents_allowed: 0,
            ...(hasAgentTypes ? { agent: "worker" } : {}),
            ...(hasIntelligence ? { intelligence: "cheap" } : {}),
          };
          validatePreparedArguments(schema, { tasks: [task] });
          if (!hasAgentTypes) {
            assert.throws(() => validatePreparedArguments(schema, { tasks: [{ ...task, agent: "worker" }] }));
            assert.doesNotMatch(String(schema.properties.tasks.description), /\{agent/);
          }
        }
      }
    }
    assert.equal(DEFAULT_AGENT.systemPrompt, "");
    assert.equal(DEFAULT_AGENT.name, "");
    assert.equal(DEFAULT_AGENT.tools, undefined);
  } finally {
    f.close();
  }
});

test("untyped workers retain task-only prompts, budgets, names, models, and named resumes", async (t) => {
  const f = settingsFixture();
  const log = path.join(f.root, "launches.jsonl");
  const script = path.join(f.root, "fake-pi.cjs");
  fs.writeFileSync(
    script,
    `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    const session = args[args.indexOf('--session-dir') + 1];
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.type !== 'prompt') return;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prompt: request.message, args,
        budget: process.env.PI_SUBAGENT_BUDGET_DIR, depth: process.env.PI_SUBAGENT_DEPTH }) + '\\n');
      fs.mkdirSync(session, { recursive: true });
      fs.writeFileSync(path.join(session, 'session.jsonl'), JSON.stringify({ type: 'session', id: 'worker' }) + '\\n');
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    });
  `,
  );
  f.write(f.agent, {
    runner: { command: process.execPath, argsPrefix: [script] },
    limits: { total: 10 },
    resume: { disableAuto: true },
  });
  process.env.PI_SUBAGENT_SESSION_ROOT = path.join(f.root, "sessions");
  const host = createExtensionHarness();
  const entries: SessionEntry[] = [];
  const ctx = host.makeCtx(entries, { cwd: f.project, hasUI: true, model: model("parent", "live") });
  const notify = t.mock.method(ctx.ui, "notify", () => {});
  const calls = () =>
    fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { prompt: string; args: string[]; budget: string; depth: string });
  const flag = (args: string[], key: string) => args[args.indexOf(key) + 1];
  try {
    await host.emit("session_start", {}, ctx);
    assert.equal(notify.mock.callCount(), 0, "no agent discovery notice");
    const prompt = (await host.emit("before_agent_start", {}, ctx)).at(-1) as { systemPrompt: string };
    assert.match(prompt.systemPrompt, /Workers receive only the task/);
    assert.doesNotMatch(prompt.systemPrompt, /code-writer|code-architect|code-reviwer|agent TYPE|Do not call/);
    assert.doesNotMatch(host.tool("subagents").description, /\{ agent,/);
    const budget = findPersistedBudget(entries)!;
    const first = await host.call(
      "subagents",
      "single",
      { tasks: [{ task: "Only my task.", max_subagents_allowed: 0 }] },
      ctx,
    );
    assert.equal(first.isError, false, JSON.stringify(first.content));
    assert.equal(first.details.results[0].agent, "");
    assert.equal(first.details.results[0].agentSource, "default");
    assert.equal(calls()[0].prompt, "Only my task.");
    assert.equal(calls()[0].args.includes("--append-system-prompt"), false);
    assert.equal(calls()[0].args.includes("--tools"), false);
    assert.equal(flag(calls()[0].args, "--model"), "parent/live");
    assert.equal(readBudget({ directory: calls()[0].budget }).limit, 0);
    const name = first.details.results[0].name!;
    assert.ok(name);
    const resumed = await host.call(
      "resume_subagents",
      "resume",
      { resumes: [{ subagent: name, task: "Follow up." }] },
      ctx,
    );
    assert.equal(resumed.isError, false, JSON.stringify(resumed.content));
    assert.equal(calls().at(-1)!.prompt, "Follow up.");
    assert.ok(calls().at(-1)!.args.includes("--session"));
    assert.equal(readBudget(budget).remaining, 9, "resuming does not reserve another slot");
    const parallel = await host.call(
      "subagents",
      "parallel",
      {
        tasks: [
          { task: "First parallel task.", max_subagents_allowed: 0 },
          { task: "Second parallel task.", max_subagents_allowed: 0 },
        ],
      },
      ctx,
    );
    assert.equal(parallel.isError, false, JSON.stringify(parallel.content));
    assert.equal(new Set(parallel.details.results.map((result) => result.name)).size, 2);
    assert.equal(readBudget(budget).remaining, 7);
    const namesFile = findPersistedNamesIdentity(entries)!.namesFile;
    assert.equal(readNamesRegistry(namesFile).agents[name].agent, "");

    const branch = await host.call(
      "subagents",
      "branch",
      { tasks: [{ task: "May launch one child.", max_subagents_allowed: 1 }] },
      ctx,
    );
    assert.equal(branch.isError, false, JSON.stringify(branch.content));
    const branchBudget = branch.details.results[0].budget!;
    Object.assign(process.env, {
      PI_SUBAGENT_DEPTH: "1",
      PI_SUBAGENT_BUDGET_DIR: branchBudget.directory,
      PI_SUBAGENT_STACK: '[""]',
      PI_SUBAGENT_NAMES_FILE: namesFile,
    });
    const child = createExtensionHarness();
    const childCtx = child.makeCtx([], { cwd: f.project, hasUI: false });
    try {
      await child.emit("session_start", {}, childCtx);
      const leaf = await child.call(
        "subagents",
        "leaf",
        { tasks: [{ task: "Nested neutral worker.", max_subagents_allowed: 0 }] },
        childCtx,
      );
      assert.equal(leaf.isError, false, JSON.stringify(leaf.content));
      assert.equal(calls().at(-1)!.prompt, "Nested neutral worker.");
      assert.equal(calls().at(-1)!.depth, "2");
      assert.equal(readBudget(branchBudget).remaining, 0);
      assert.equal(readBudget(budget).remaining, 5);
    } finally {
      await child.emit("session_shutdown", {}, childCtx);
      for (const key of [
        "PI_SUBAGENT_DEPTH",
        "PI_SUBAGENT_BUDGET_DIR",
        "PI_SUBAGENT_STACK",
        "PI_SUBAGENT_NAMES_FILE",
      ]) {
        delete process.env[key];
      }
    }

    for (const choices of [configured.slice(0, 1), configured]) {
      f.write(f.agent, {
        runner: { command: process.execPath, argsPrefix: [script] },
        resume: { disableAuto: true },
        "subagents-models": choices,
      });
      await host.emit("session_start", {}, ctx);
      const task = { task: "Selected model.", max_subagents_allowed: 0 };
      if (choices.length > 1) await assert.rejects(host.call("subagents", "missing", { tasks: [task] }, ctx));
      const selected = await host.call(
        "subagents",
        `preset-${choices.length}`,
        { tasks: [{ ...task, ...(choices.length > 1 ? { intelligence: "cheap" } : {}) }] },
        ctx,
      );
      assert.equal(selected.isError, false, JSON.stringify(selected.content));
      assert.equal(calls().at(-1)!.prompt, task.task);
      assert.equal(flag(calls().at(-1)!.args, "--provider"), "local");
      assert.equal(selected.details.results[0].intelligence, "cheap");
    }

    const dir = path.join(f.project, ".pi/agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "worker.md"), "---\nname: custom\ndescription: custom role\n---\nROLE.");
    await host.emit("session_start", { reason: "startup" }, ctx);
    assert.equal(notify.mock.callCount(), 0, "no discovery notice for user-created definitions either");
    const itemFields = () =>
      (host.tool("subagents").parameters as unknown as ReturnType<typeof createIntelligenceSchemas>["subagents"])
        .properties.tasks.items.properties;
    assert.ok(Object.hasOwn(itemFields(), "agent"));
    fs.writeFileSync(
      path.join(dir, "worker.md"),
      "---\nname: custom\ndescription: custom role\nfirst-layer: disabled\n---\nROLE.",
    );
    await host.emit("session_start", {}, ctx);
    assert.equal(Object.hasOwn(itemFields(), "agent"), false);
    const neutral = await host.call(
      "subagents",
      "restricted-type",
      { tasks: [{ task: "No role instructions.", max_subagents_allowed: 0, intelligence: "cheap" }] },
      ctx,
    );
    assert.equal(neutral.isError, false, JSON.stringify(neutral.content));
    assert.equal(calls().at(-1)!.prompt, "No role instructions.");
    assert.equal(calls().at(-1)!.args.includes("--append-system-prompt"), false);
    fs.unlinkSync(path.join(dir, "worker.md"));
    await host.emit("session_start", {}, ctx);
    assert.equal(Object.hasOwn(itemFields(), "agent"), false);
  } finally {
    await host.emit("session_shutdown", {}, ctx);
    f.close();
  }
});

test("crash recovery accepts task-only recorded calls and keeps the saved worker identity", () => {
  const f = settingsFixture();
  try {
    const host = createExtensionHarness();
    const task = { task: "unfinished", max_subagents_allowed: 0 };
    const ctx = host.makeCtx([
      messageEntry(
        fauxAssistantMessage(
          {
            type: "toolCall",
            id: "interrupted",
            name: "subagents",
            arguments: { tasks: [task] },
          },
          { stopReason: "toolUse" },
        ),
        "call",
      ),
    ]);
    const plans = findLatestResumableSubagentCalls(ctx);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].tasks[0].agent, "");
    const prepared = prepareRecoveryArguments({ tasks: plans[0].tasks }, plans, [], undefined, false);
    assert.deepEqual(prepared, { tasks: [task] });
    validatePreparedArguments(createIntelligenceSchemas([], undefined, false).subagents, prepared);
    assert.equal(findRecoveryPlanIndex([{ ...task, agent: "" }], plans, [], undefined, false), 0);
    const legacyPlans = [{ previousToolCallId: "legacy", tasks: [{ ...task, agent: "old-type" }] }];
    assert.deepEqual(prepareRecoveryArguments({ tasks: legacyPlans[0].tasks }, legacyPlans, [], undefined, false), {
      tasks: [task],
    });
    assert.equal(findRecoveryPlanIndex([{ ...task, agent: "" }], legacyPlans, [], undefined, false), 0);
    const mismatched = { tasks: [{ ...task, agent: "unknown" }] };
    assert.equal(prepareRecoveryArguments(mismatched, plans, [], undefined, false), mismatched);
    assert.equal(prepareRecoveryArguments(mismatched, legacyPlans, [], undefined, false), mismatched);
    assert.throws(() =>
      validatePreparedArguments(
        createIntelligenceSchemas([], undefined, false).subagents,
        prepareRecoveryArguments({ tasks: [{ ...task, agent: "unknown" }] }, [], [], undefined, false),
      ),
    );
  } finally {
    f.close();
  }
});
