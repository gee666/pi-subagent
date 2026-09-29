import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createExtensionHarness, customEntry, hostDouble, model } from "./helpers/extension.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_NAMES_CUSTOM_TYPE, readNamesRegistry } from "../names.js";
import { findPersistedBudget, readBudget } from "../budget.js";

const settings = [
  { junior: { model: "org/model", provider: "chosen", "reasoning-level": "high", description: "Small changes" } },
  { expert: { model: "big", provider: "other", "reasoning-level": "max" } },
];
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

test("launch and named resume apply per-item choices, omission defaults, and schema refreshes", async (t) => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/intelligence-tools-"));
  const log = path.join(root, "calls.jsonl");
  const script = path.join(root, "fake-pi.cjs");
  fs.writeFileSync(
    script,
    `
    const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
    const args = process.argv, session = args[args.indexOf('--session-dir') + 1];
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line); if (request.type !== 'prompt') return;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prompt: request.message, args }) + '\\n');
      fs.mkdirSync(session, { recursive: true });
      fs.writeFileSync(path.join(session, 'session.jsonl'), JSON.stringify({ type: 'session', id: 'fake' }) + '\\n');
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    });
  `,
  );
  const variables = {
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
    const parallel = await host.call(
      "subagents",
      "parallel",
      { tasks: [task("expert work", "expert"), { ...task("default work"), intelligence: null }] },
      ctx,
    );
    assert.equal(parallel.isError, false, JSON.stringify(parallel.content));
    const expert = calls().find((call) => call.prompt.includes("expert work"))!;
    const omitted = calls().find((call) => call.prompt.includes("default work"))!;
    assert.equal(flag(expert.args, "--provider"), "other");
    assert.equal(flag(expert.args, "--thinking"), "max");
    assert.equal(flag(omitted.args, "--model"), "parent/live");
    assert.equal(flag(omitted.args, "--thinking"), "low");
    assert.equal(omitted.args.includes("--provider"), false);
    const before = readBudget(budget).remaining;
    await assert.rejects(
      host.call(
        "resume_subagents",
        "bad-resume",
        { resumes: [{ subagent: name, task: "bad", intelligence: "missing", max_subagents_allowed: 2 }] },
        ctx,
      ),
    );
    assert.equal(readBudget(budget).remaining, before);
    const resumed = await host.call(
      "resume_subagents",
      "resumed",
      {
        resumes: [
          { subagent: name, task: "resume expert", intelligence: "expert" },
          { subagent: parallel.details.results[0].name, task: "resume default", intelligence: null },
        ],
      },
      ctx,
    );
    assert.equal(resumed.isError, false, JSON.stringify(resumed.content));
    const selectedResume = calls().find((call) => call.prompt === "resume expert")!;
    const defaultResume = calls().find((call) => call.prompt === "resume default")!;
    assert.equal(flag(selectedResume.args, "--model"), "big");
    assert.equal(flag(selectedResume.args, "--provider"), "other");
    assert.equal(flag(selectedResume.args, "--thinking"), "max");
    assert.equal(selectedResume.args.includes("--continue"), true);
    assert.equal(flag(defaultResume.args, "--model"), "parent/live");
    assert.equal(flag(defaultResume.args, "--thinking"), "low");
    assert.equal(readBudget(budget).remaining, before);
    const nullLaunch = await host.call(
      "subagents",
      "null-single",
      { tasks: [{ ...task("null launch"), intelligence: null }] },
      ctx,
    );
    assert.equal(nullLaunch.isError, false, JSON.stringify(nullLaunch.content));
    for (const args of [
      { resumes: { subagent: nullLaunch.details.results[0].name, task: "null object resume", intelligence: null } },
      { subagent: nullLaunch.details.results[0].name, task: "null shorthand resume", intelligence: null },
    ]) {
      const result = await host.call("resume_subagents", "null-resume", args, ctx);
      assert.equal(result.isError, false, JSON.stringify(result.content));
    }
    for (const call of calls().filter((call) => call.prompt.includes("null "))) {
      assert.equal(flag(call.args, "--model"), "parent/live");
      assert.equal(flag(call.args, "--thinking"), "low");
      assert.equal(call.args.includes("--provider"), false);
    }
    fs.writeFileSync(config, JSON.stringify({ "subagents-models": [{ renamed: settings[0].junior }] }));
    await host.emit("session_start", {}, ctx);
    assert.notEqual(host.tool("subagents").parameters, initialSchema);
    assert.match(JSON.stringify(host.tool("subagents").parameters), /renamed/);
    assert.doesNotMatch(JSON.stringify(host.tool("resume_subagents").parameters), /expert/);
    process.env.PI_SUBAGENT_INTELLIGENCE = "0";
    await host.emit("session_start", {}, ctx);
    assert.equal(JSON.stringify(host.tool("subagents").parameters).includes('"intelligence"'), false);
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
