import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createExtensionHarness, customEntry, hostDouble, model } from "./helpers/extension.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_NAMES_CUSTOM_TYPE, readNamesRegistry } from "../names.js";
import { findPersistedBudget, readBudget } from "../budget.js";
import { buildSubagentDetail, renderTurnOverviewLines } from "../detail.js";
import { SUBAGENT_INTELLIGENCE_CUSTOM_TYPE } from "../intelligence.js";
import { renderResult } from "../render.js";
import { forkSessionInto } from "../names.js";
import type { ThemeFg } from "../tree.js";

const settings = [
  { junior: { model: "org/model", provider: "chosen", "reasoning-level": "high", description: "Small changes" } },
  { expert: { model: "big", provider: "other", "reasoning-level": "max" } },
];
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test("named resumes retain original settings across preset, parent, definition, and owner changes", async (t) => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/intelligence-tools-"));
  const log = path.join(root, "calls.jsonl");
  const script = path.join(root, "fake-pi.cjs");
  fs.writeFileSync(
    script,
    `
    const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
    const args = process.argv, session = args[args.indexOf('--session-dir') + 1];
    const chosen = args[args.indexOf('--model') + 1];
    const provider = args.includes('--provider') ? args[args.indexOf('--provider') + 1] : chosen.split('/')[0];
    const modelId = args.includes('--provider') ? chosen : chosen.slice(provider.length + 1);
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line); if (request.type !== 'prompt') return;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prompt: request.message, args }) + '\\n');
      fs.mkdirSync(session, { recursive: true });
      const file = path.join(session, 'session.jsonl');
      if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'fake' }) + '\\n');
      for (const entry of [
        { type: 'custom', customType: ${JSON.stringify(SUBAGENT_INTELLIGENCE_CUSTOM_TYPE)}, data: { intelligence: JSON.parse(process.env.PI_SUBAGENT_RUN_INTELLIGENCE) } },
        { type: 'model_change', provider, modelId },
        { type: 'thinking_level_change', thinkingLevel: args[args.indexOf('--thinking') + 1] },
        { type: 'message', message: { role: 'user', content: request.message } },
      ]) fs.appendFileSync(file, JSON.stringify(entry) + '\\n');
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    });
  `,
  );
  const variables = {
    HOME: path.join(root, "home"),
    PI_SUBAGENT_RUN_INTELLIGENCE: "null",
    PI_CODING_AGENT_DIR: path.join(root, "user"),
    PI_SUBAGENT_INTELLIGENCE: "true",
    PI_SUBAGENT_MAX_TOTAL_AGENTS: "10",
    PI_SUBAGENT_DEPTH: "0",
    PI_SUBAGENT_STACK: "[]",
    PI_SUBAGENT_BUDGET_DIR: "",
    PI_SUBAGENT_SESSION_ROOT: path.join(root, "sessions/subagents"),
    PI_SUBAGENT_NAMES_FILE: "",
    PI_SUBAGENT_CONFIRM_PROJECT_AGENTS: "false",
    PI_SUBAGENT_PI_COMMAND: process.execPath,
    PI_SUBAGENT_PI_ARGS_PREFIX: JSON.stringify([script]),
    PI_SUBAGENT_DISABLE_RESUME: "true",
    DISABLE_RESUMABLE_SUBAGENTS: "false",
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(variables.PI_CODING_AGENT_DIR);
  fs.writeFileSync(
    path.join(root, ".pi/agents/worker.md"),
    "---\nname: intelligence-worker\ndescription: worker\nmodel: legacy/model\nthinking: low\n---\nDo work.\n",
  );
  const config = path.join(root, ".pi/pi-subagent.json");
  fs.writeFileSync(config, JSON.stringify({ "subagents-models": settings }));
  const namesFile = path.join(root, "names.json");
  const entries = [customEntry(SUBAGENT_NAMES_CUSTOM_TYPE, { namesFile, ownerId: "root" })];
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  const host = createExtensionHarness();
  const ctx = host.makeCtx(entries, {
    cwd: root,
    hasUI: false,
    isProjectTrusted: () => true,
    model: model("parent", "live"),
    modelRegistry: hostDouble<ExtensionContext["modelRegistry"]>({}),
    sessionManager: hostDouble<ExtensionContext["sessionManager"]>({
      getEntries: () => entries,
      getBranch: () => entries,
      getLeafId: () => null,
      getSessionId: () => "root",
      getSessionDir: () => path.join(root, "sessions"),
    }),
  });
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { prompt: string; args: string[] })
      : [];
  const task = (task: string, intelligence?: string) => ({
    agent: "intelligence-worker",
    task,
    max_subagents_allowed: 0,
    ...(intelligence ? { intelligence } : {}),
  });
  try {
    // Untrusted project presets are not declared. Session startup then registers trusted ones.
    assert.equal(JSON.stringify(host.tool("subagents").parameters).includes('"intelligence"'), false);
    await host.emit("session_start", {}, ctx);
    const initialSchema = host.tool("subagents").parameters;
    assert.match(JSON.stringify(initialSchema), /Small changes/);
    await host.emit("before_agent_start", {}, ctx);
    const budget = findPersistedBudget(entries)!;
    await assert.rejects(host.call("subagents", "bad", { tasks: [task("bad", "missing")] }, ctx));
    for (const missing of [{}, { intelligence: null }]) {
      const invalid = { ...task("missing choice"), ...missing };
      for (const tasks of [
        [invalid],
        [task("valid choice", "junior"), invalid],
        [invalid, task("valid choice", "expert")],
      ]) {
        await assert.rejects(host.call("subagents", "missing-launch-choice", { tasks }, ctx));
      }
    }
    assert.equal(readBudget(budget).remaining, 10);
    assert.equal(calls().length, 0);
    assert.equal(fs.existsSync(namesFile), false);
    const single = await host.call("subagents", "single", { tasks: [task("single", "junior")] }, ctx);
    assert.equal(single.isError, false, JSON.stringify(single.content));
    assert.equal(flag(calls()[0].args, "--provider"), "chosen");
    assert.equal(flag(calls()[0].args, "--model"), "org/model");
    assert.equal(flag(calls()[0].args, "--thinking"), "high");
    const name = single.details.results[0].name!;
    assert.equal(readNamesRegistry(namesFile).agents[name].model, "chosen/org/model");
    assert.equal(readNamesRegistry(namesFile).agents[name].intelligence, "junior");
    assert.equal(readNamesRegistry(namesFile).agents[name].thinking, "high");
    assert.equal(JSON.parse(JSON.stringify(single.details)).results[0].thinking, "high");
    assert.equal(JSON.parse(JSON.stringify(single.details)).results[0].intelligence, "junior");
    const theme = { fg: ((_color, text) => text) as ThemeFg, bold: (text: string) => text };
    assert.ok(
      renderResult(single, false, theme).render(160).join("\n").includes(`${name} (Junior/intelligence-worker)`),
    );
    const parallel = await host.call(
      "subagents",
      "parallel",
      { tasks: [task("expert work", "expert"), task("junior work", "junior")] },
      ctx,
    );
    assert.equal(parallel.isError, false, JSON.stringify(parallel.content));
    const expert = calls().find((call) => call.prompt.includes("expert work"))!;
    const junior = calls().find((call) => call.prompt.includes("junior work"))!;
    assert.equal(flag(expert.args, "--provider"), "other");
    assert.equal(flag(expert.args, "--thinking"), "max");
    assert.equal(flag(junior.args, "--model"), "org/model");
    assert.equal(flag(junior.args, "--thinking"), "high");
    assert.equal(flag(junior.args, "--provider"), "chosen");
    const before = readBudget(budget).remaining;
    await assert.rejects(
      host.call(
        "resume_subagents",
        "bad-resume",
        { resumes: [{ subagent: name, task: "bad", intelligence: "missing", max_subagents_allowed: 2 }] },
        ctx,
      ),
    );
    const beforeCalls = calls().length;
    const beforeNames = fs.readFileSync(namesFile, "utf8");
    assert.equal(JSON.stringify(host.tool("resume_subagents").parameters).includes('"intelligence"'), false);
    for (const intelligence of ["junior", "missing", null, 7]) {
      const invalid = { subagent: name, task: "invalid choice", max_subagents_allowed: 2, intelligence };
      const valid = { subagent: parallel.details.results[0].name, task: "follow up" };
      for (const args of [
        invalid,
        { resumes: invalid },
        { resumes: [invalid] },
        { resumes: [valid, invalid] },
        { resumes: [invalid, valid] },
      ]) {
        await assert.rejects(host.call("resume_subagents", "invalid-resume-choice", args, ctx));
      }
    }
    assert.equal(readBudget(budget).remaining, before);
    assert.equal(calls().length, beforeCalls, "invalid resume batches must not spawn any worker");
    assert.equal(fs.readFileSync(namesFile, "utf8"), beforeNames, "invalid resumes must not change saved names");
    const resumed = await host.call(
      "resume_subagents",
      "resumed",
      {
        resumes: [
          { subagent: name, task: "resume junior" },
          { subagent: parallel.details.results[0].name, task: "resume expert" },
        ],
      },
      ctx,
    );
    assert.equal(resumed.isError, false, JSON.stringify(resumed.content));
    const selectedResume = calls().find((call) => call.prompt === "resume expert")!;
    const juniorResume = calls().find((call) => call.prompt === "resume junior")!;
    assert.equal(flag(selectedResume.args, "--model"), "big");
    assert.equal(flag(selectedResume.args, "--provider"), "other");
    assert.equal(flag(selectedResume.args, "--thinking"), "max");
    assert.equal(selectedResume.args.includes("--continue"), true);
    assert.equal(flag(juniorResume.args, "--model"), "org/model");
    assert.equal(flag(juniorResume.args, "--thinking"), "high");
    assert.equal(flag(juniorResume.args, "--provider"), "chosen");
    assert.equal(readBudget(budget).remaining, before);
    assert.equal(resumed.details.results[0].intelligence, "junior");
    assert.equal(resumed.details.results[1].intelligence, "expert");
    assert.equal(single.details.results[0].intelligence, "junior", "resume cannot rewrite earlier results");
    const detail = buildSubagentDetail(readNamesRegistry(namesFile).agents[name]);
    assert.deepEqual(
      detail.blocks.map((block) => block.intelligence),
      ["junior", "junior"],
    );
    assert.match(
      renderTurnOverviewLines(detail, 0, 160).join("\n"),
      /Model: chosen\/org\/model • Thinking: high • Intelligence: Junior/,
    );
    assert.match(
      renderTurnOverviewLines(detail, 1, 160).join("\n"),
      /Model: chosen\/org\/model • Thinking: high • Intelligence: Junior/,
    );
    const forkDir = path.join(root, "fork");
    assert.equal(forkSessionInto(detail.sessionDir, forkDir), true);
    assert.deepEqual(
      buildSubagentDetail(readNamesRegistry(namesFile).agents[name], { sessionDir: forkDir }).blocks.map(
        (block) => block.intelligence,
      ),
      ["junior", "junior"],
    );
    ctx.model = model("changed-parent", "different");
    fs.writeFileSync(
      path.join(root, ".pi/agents/worker.md"),
      "---\nname: intelligence-worker\ndescription: worker\nmodel: changed/model\nthinking: off\n---\nChanged.\n",
    );
    fs.writeFileSync(config, JSON.stringify({ "subagents-models": [{ renamed: settings[0].junior }] }));
    await host.emit("session_start", {}, ctx);
    assert.notEqual(host.tool("subagents").parameters, initialSchema);
    for (const tool of ["subagents", "resume_subagents"]) {
      assert.equal(JSON.stringify(host.tool(tool).parameters).includes('"intelligence"'), false);
    }
    const sole = await host.call(
      "subagents",
      "sole",
      { tasks: [{ ...task("automatic sole"), intelligence: null }] },
      ctx,
    );
    assert.equal(sole.isError, false, JSON.stringify(sole.content));
    assert.equal(sole.details.results[0].intelligence, "renamed");
    assert.equal(flag(calls().at(-1)!.args, "--model"), "org/model");
    const soleResume = await host.call(
      "resume_subagents",
      "sole-resume",
      { resumes: { subagent: name, task: "automatic resume" } },
      ctx,
    );
    assert.equal(soleResume.details.results[0].intelligence, "junior");
    assert.equal(flag(calls().at(-1)!.args, "--thinking"), "high");
    assert.equal(readNamesRegistry(namesFile).agents[name].intelligence, "junior", "registry keeps initial label only");
    process.env.PI_SUBAGENT_INTELLIGENCE = "0";
    await host.emit("session_start", {}, ctx);
    assert.equal(JSON.stringify(host.tool("subagents").parameters).includes('"intelligence"'), false);
    const disabled = await host.call(
      "subagents",
      "disabled",
      { tasks: [{ ...task("disabled work"), intelligence: null }] },
      ctx,
    );
    assert.equal(disabled.details.results[0].intelligence, undefined);
    assert.equal(flag(calls().at(-1)!.args, "--model"), "changed-parent/different");
    const disabledName = disabled.details.results[0].name!;
    const disabledResume = await host.call(
      "resume_subagents",
      "disabled-resume",
      { resumes: { subagent: name, task: "disabled resume" } },
      ctx,
    );
    assert.equal(disabledResume.details.results[0].intelligence, "junior");
    assert.equal(flag(calls().at(-1)!.args, "--thinking"), "high");
    fs.writeFileSync(config, JSON.stringify({ "subagents-models": [] }));
    process.env.PI_SUBAGENT_INTELLIGENCE = "true";
    await host.emit("session_start", {}, ctx);
    const zero = await host.call("subagents", "zero", { tasks: [{ ...task("zero work"), intelligence: null }] }, ctx);
    const zeroResume = await host.call("resume_subagents", "zero-resume", { subagent: name, task: "zero resume" }, ctx);
    assert.equal(zero.details.results[0].intelligence, undefined);
    assert.equal(zeroResume.details.results[0].intelligence, "junior");
    assert.equal(flag(calls().at(-1)!.args, "--model"), "org/model");
    const finalDetail = buildSubagentDetail(readNamesRegistry(namesFile).agents[name]);
    assert.deepEqual(
      finalDetail.blocks.map((block) => block.intelligence),
      ["junior", "junior", "junior", "junior", "junior"],
    );
    assert.match(renderTurnOverviewLines(finalDetail, 4, 160).join("\n"), /Intelligence: Junior/);

    // New extension instance, changed presets and missing definition: no dependence on in-memory state.
    fs.unlinkSync(path.join(root, ".pi/agents/worker.md"));
    fs.writeFileSync(config, JSON.stringify({ "subagents-models": settings }));
    const restarted = createExtensionHarness();
    await restarted.emit("session_start", {}, ctx);
    const unselected = await restarted.call(
      "resume_subagents",
      "unselected",
      { resumes: [{ subagent: disabledName, task: "unselected remains unselected" }] },
      ctx,
    );
    assert.equal(unselected.isError, false, JSON.stringify(unselected.content));
    assert.equal(unselected.details.results[0].intelligence, undefined);
    assert.equal(flag(calls().at(-1)!.args, "--provider"), "changed-parent");
    assert.equal(flag(calls().at(-1)!.args, "--model"), "different");
    assert.equal(flag(calls().at(-1)!.args, "--thinking"), "off");
    entries[0] = customEntry(SUBAGENT_NAMES_CUSTOM_TYPE, { namesFile, ownerId: "other-owner" });
    await restarted.emit("session_start", {}, ctx);
    for (const task of ["private fork", "same private fork"]) {
      const forked = await restarted.call("resume_subagents", task, { subagent: name, task }, ctx);
      assert.equal(forked.isError, false, JSON.stringify(forked.content));
      assert.equal(forked.details.results[0].intelligence, "junior");
      assert.equal(flag(calls().at(-1)!.args, "--model"), "org/model");
      assert.equal(flag(calls().at(-1)!.args, "--thinking"), "high");
    }
    const last = calls().slice(-2);
    assert.equal(flag(last[0].args, "--session-dir"), flag(last[1].args, "--session-dir"));
    assert.notEqual(flag(last[0].args, "--session-dir"), detail.sessionDir);
    assert.equal(buildSubagentDetail(readNamesRegistry(namesFile).agents[name]).blocks.length, 5);
    await restarted.emit("session_shutdown", {}, ctx);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    await host.emit("session_shutdown", {}, ctx);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
