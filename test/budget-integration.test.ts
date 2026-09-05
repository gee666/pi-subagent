import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import extension from "../index.js";
import { findPersistedBudget, readBudget, SUBAGENT_BUDGET_CUSTOM_TYPE, type SubagentBudget } from "../budget.js";
import { readNamesRegistry, SUBAGENT_NAMES_CUSTOM_TYPE } from "../names.js";

function workspace(): string {
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
  return fs.mkdtempSync(path.join(process.cwd(), "tmp", "budget-integration-"));
}

async function withSetup(run: (dir: string, log: string) => Promise<void>) {
  const dir = workspace();
  const log = path.join(dir, "launches.jsonl");
  const variables: Record<string, string> = {
    PI_SUBAGENT_MAX_TOTAL_AGENTS: "5",
    PI_SUBAGENT_DEPTH: "0",
    PI_SUBAGENT_STACK: "[]",
    PI_SUBAGENT_BUDGET_DIR: "",
    PI_SUBAGENT_CONFIRM_PROJECT_AGENTS: "false",
    PI_SUBAGENT_PI_COMMAND: process.execPath,
    PI_SUBAGENT_DISABLE_RESUME: "true",
    DISABLE_RESUMABLE_SUBAGENTS: "false",
  };
  const script = path.join(dir, "fake-pi.cjs");
  fs.writeFileSync(script, `
    const fs = require('node:fs');
    const path = require('node:path');
    const readline = require('node:readline');
    const args = process.argv;
    const session = args[args.indexOf('--session-dir') + 1];
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.type !== 'prompt') return;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prompt: request.message, budget: process.env.PI_SUBAGENT_BUDGET_DIR, args }) + '\\n');
      fs.mkdirSync(session, { recursive: true });
      fs.writeFileSync(path.join(session, 'session.jsonl'), JSON.stringify({ type: 'session', id: 'fake' }) + '\\n');
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    });
  `);
  variables.PI_SUBAGENT_PI_ARGS_PREFIX = JSON.stringify([script]);
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  const agents = path.join(dir, ".pi", "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "worker.md"), "---\nname: budget-worker\ndescription: Test worker\n---\nDo the work.\n");
  try { await run(dir, log); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function harness(dir: string, id: string, budget?: SubagentBudget, entries?: any[]) {
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const saved = entries ?? [{ type: "custom", customType: SUBAGENT_NAMES_CUSTOM_TYPE, data: { namesFile: path.join(dir, "names.json"), ownerId: id } }];
  if (budget) saved.push({ type: "custom", customType: SUBAGENT_BUDGET_CUSTOM_TYPE, data: budget });
  const ctx: any = {
    cwd: dir, hasUI: false,
    isProjectTrusted: () => true,
    model: { provider: "test", id: "model" },
    modelRegistry: {},
    sessionManager: {
      getEntries: () => saved, getBranch: () => saved, getLeafId: () => null,
      getSessionId: () => id, getSessionDir: () => path.join(dir, "sessions", id),
    },
    ui: { notify() {}, setStatus() {} },
  };
  const pi: any = {
    registerFlag() {}, getFlag() {}, registerProvider() {}, registerCommand() {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    getActiveTools: () => [], setActiveTools() {},
    appendEntry: (customType: string, data: unknown) => saved.push({ type: "custom", customType, data }),
    on(event: string, handler: Function) {
      handlers.set(event, [...handlers.get(event) ?? [], handler]);
    },
  };
  extension(pi);
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  return {
    tools, ctx, entries: saved,
    async call(name: string, id: string, args: unknown) {
      return tools.get(name).execute(id, args, undefined, undefined, ctx);
    },
    async prompt() {
      let result: any;
      for (const handler of handlers.get("before_agent_start") ?? []) result = await handler({ systemPrompt: "base" }, ctx);
      return result.systemPrompt;
    },
  };
}

function task(max_agents_allowed: number) {
  return { agent: "budget-worker", task: "work", max_agents_allowed };
}

function calls(log: string): any[] {
  return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

describe("budget tool integration", () => {
  test("resume guidance does not impose follow-up size or cost restrictions", async () => {
    await withSetup(async (dir) => {
      const root = await harness(dir, "root");
      const description = root.tools.get("resume_subagents").description;
      assert.match(description, /keeping their previous context/);
      for (const text of [description, await root.prompt()]) {
        assert.doesNotMatch(text, /substantial follow-up|Resumes still cost money|Do small edits|same efficiency and delegation-allowance rules|Access to names does not justify/);
      }
    });
  });

  test("hides large main-agent allowances but shows small and delegated allowances", async () => {
    await withSetup(async (dir) => {
      process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS = "1000";
      const main = await harness(dir, "main");
      assert.doesNotMatch(await main.prompt(), /\b1000\b/);
      const rejected = await main.call("subagents", "too-large", { tasks: [task(1001)] });
      assert.equal(rejected.isError, true);
      assert.doesNotMatch(rejected.content[0].text, /\b1000\b/);
      const budget = findPersistedBudget(main.entries)!;
      assert.equal(readBudget(budget).remaining, 1000);
      process.env.PI_SUBAGENT_DEPTH = "1";
      const child = await harness(dir, "child", budget);
      assert.match(await child.prompt(), /launch at most 1000 more/);
      process.env.PI_SUBAGENT_DEPTH = "0";
      process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS = "29";
      const small = await harness(dir, "small");
      assert.match(await small.prompt(), /launch at most 29 more/);
    });
  });

  test("requires an allowance and rejects an oversized batch before starting or naming workers", async () => {
    await withSetup(async (dir, log) => {
      const h = await harness(dir, "root");
      const schema = h.tools.get("subagents").parameters.properties.tasks.items;
      assert.ok(schema.required.includes("max_agents_allowed"));
      assert.equal(schema.properties.max_agents_allowed.minimum, 1);
      assert.equal(schema.properties.max_agents_in_branch, undefined);
      assert.equal(schema.properties.max_subagents_allowed, undefined);
      const missing = await h.call("subagents", "missing", { tasks: [{ agent: "budget-worker", task: "work" }] });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /max_agents_allowed is required/);
      const zero = await h.call("subagents", "zero", { tasks: [task(0)] });
      assert.equal(zero.isError, true);
      const rejected = await h.call("subagents", "too-large", { tasks: [task(4), task(3)] });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /needs 7 slots.*has 5 slots left/);
      assert.equal(readBudget(findPersistedBudget(h.entries)!).remaining, 5);
      assert.equal(calls(log).length, 0);
      assert.equal(fs.existsSync(path.join(dir, "names.json")), false);
    });
  });

  test("passes private branch budgets through launches, nested calls, resumes, forks, and reloads", async () => {
    await withSetup(async (dir, log) => {
      const root = await harness(dir, "root");
      const result = await root.call("subagents", "first", { tasks: [task(3), task(2)] });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      const [a, b] = result.details.results;
      assert.notEqual(a.budget.directory, b.budget.directory);
      const rootBudget = findPersistedBudget(root.entries)!;
      assert.equal(readBudget(rootBudget).remaining, 0);
      assert.equal(readBudget(a.budget).remaining, 2);
      assert.equal(readBudget(b.budget).remaining, 1);
      for (const record of calls(log)) {
        assert.match(record.prompt, /You may launch at most [12] more subagents?/);
        assert.match(record.prompt, /exactly the number of slots reserved/);
        assert.ok([a.budget.directory, b.budget.directory].includes(record.budget));
      }
      assert.deepEqual(readNamesRegistry(path.join(dir, "names.json")).agents[a.name].budget, a.budget);

      process.env.PI_SUBAGENT_DEPTH = "1";
      process.env.PI_SUBAGENT_BUDGET_DIR = a.budget.directory;
      const branch = await harness(dir, "branch");
      process.env.PI_SUBAGENT_BUDGET_DIR = "";
      assert.deepEqual(findPersistedBudget(branch.entries), a.budget);
      const tooLarge = await branch.call("subagents", "too-large", { tasks: [task(3)] });
      assert.equal(tooLarge.isError, true);
      assert.match(tooLarge.content[0].text, /needs 3 slots.*has 2 slots left/);
      const leaves = await branch.call("subagents", "leaves", { tasks: [task(1), task(1)] });
      assert.notEqual(leaves.isError, true, JSON.stringify(leaves.content));
      assert.equal(readBudget(a.budget).remaining, 0);
      assert.equal(readBudget(b.budget).remaining, 1);
      assert.equal(readBudget(rootBudget).remaining, 0);
      process.env.PI_SUBAGENT_DEPTH = "0";

      const resumed = await root.call("resume_subagents", "resume", { resumes: [{ subagent: a.name, task: "continue" }] });
      assert.notEqual(resumed.isError, true, JSON.stringify(resumed.content));
      assert.deepEqual(resumed.details.results[0].budget, a.budget);
      assert.match(calls(log).at(-1).prompt, /You may launch at most 0 more subagents/);
      assert.equal(readBudget(rootBudget).remaining, 0);

      // A different owner gets a session fork, not a fresh descendant allowance.
      const forked = await branch.call("resume_subagents", "fork", { resumes: [{ subagent: b.name, task: "follow up" }] });
      assert.notEqual(forked.isError, true, JSON.stringify(forked.content));
      assert.deepEqual(forked.details.results[0].budget, b.budget);
      assert.equal(readBudget(b.budget).remaining, 1);

      process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS = "500";
      const reloaded = await harness(dir, "new-session-id", undefined, [...root.entries]);
      const denied = await reloaded.call("subagents", "another", { tasks: [task(1)] });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /has 0 slots left/);
      assert.equal(readBudget(findPersistedBudget(reloaded.entries)!).limit, 5);
    });
  });

  test("optional resume overrides persist, preserve unique names, and reject unaffordable increases", async () => {
    await withSetup(async (dir, log) => {
      const root = await harness(dir, "root");
      const result = await root.call("subagents", "first", { tasks: [task(2)] });
      const worker = result.details.results[0];
      const parentBudget = findPersistedBudget(root.entries)!;
      const resume = (id: string, max_agents_allowed?: number) => root.call("resume_subagents", id, {
        resumes: [{ subagent: worker.name, task: "continue", ...(max_agents_allowed === undefined ? {} : { max_agents_allowed }) }],
      });
      const raised = await resume("raise", 4);
      assert.notEqual(raised.isError, true, JSON.stringify(raised.content));
      assert.equal(readBudget(parentBudget).remaining, 1);
      assert.equal(readBudget(worker.budget).remaining, 3);
      assert.match(calls(log).at(-1).prompt, /launch at most 3 more/);
      assert.notEqual((await resume("unchanged")).isError, true);
      assert.equal(readBudget(worker.budget).remaining, 3);
      assert.notEqual((await resume("lower", 1)).isError, true);
      assert.equal(readBudget(worker.budget).remaining, 0);
      assert.equal(readBudget(parentBudget).remaining, 1);
      assert.notEqual((await resume("restore", 4)).isError, true);
      assert.equal(readBudget(parentBudget).remaining, 1);
      const before = calls(log).length;
      const denied = await resume("too-large", 6);
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /needs 2 extra slots/);
      assert.equal(calls(log).length, before);
      assert.equal(readBudget(worker.budget).remaining, 3);
      assert.equal(readBudget(parentBudget).remaining, 1);
      assert.equal((await resume("invalid", 0)).isError, true);
      assert.equal(calls(log).length, before);
      assert.equal(Object.keys(readNamesRegistry(path.join(dir, "names.json")).agents).length, 1);
      const reloaded = await harness(dir, "reloaded", undefined, [...root.entries]);
      const continued = await reloaded.call("resume_subagents", "after-reload", { resumes: [{ subagent: worker.name, task: "continue" }] });
      assert.notEqual(continued.isError, true, JSON.stringify(continued.content));
      assert.equal(readBudget(worker.budget).remaining, 3);
    });
  });

  test("budgets still apply with named resumes disabled", async () => {
    await withSetup(async (dir, log) => {
      process.env.DISABLE_RESUMABLE_SUBAGENTS = "true";
      process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS = "1";
      const h = await harness(dir, "root");
      assert.equal(h.tools.has("resume_subagents"), false);
      const result = await h.call("subagents", "one", { tasks: [task(1)] });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.ok(result.details.results[0].budget);
      const denied = await h.call("subagents", "two", { tasks: [task(1)] });
      assert.equal(denied.isError, true);
      assert.equal(calls(log).length, 1);
    });
  });
});
