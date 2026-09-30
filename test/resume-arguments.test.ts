import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, customEntry, hostDouble, model } from "./helpers/extension.js";
import { createBudget, reserveSubagentBudgets, readBudget, SUBAGENT_BUDGET_CUSTOM_TYPE } from "../budget.js";
import { allocateSubagentNames, readNamesRegistry, SUBAGENT_NAMES_CUSTOM_TYPE } from "../names.js";

/** Exercise real registered prepareArguments -> execute callbacks with no model or network calls. */
test("registered resume callbacks accept strict-provider null budgets for batches, objects and shorthand", async () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/resume-arguments-"));
  const log = path.join(root, "calls.jsonl");
  const script = path.join(root, "fake-pi.cjs");
  fs.writeFileSync(
    script,
    `
    const fs = require('node:fs');
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line); if (request.type !== 'prompt') return;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prompt: request.message, args: process.argv,
        intelligence: JSON.parse(process.env.PI_SUBAGENT_RUN_INTELLIGENCE) }) + '\\n');
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: 'resumed' }], stopReason: 'stop' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    });
  `,
  );
  const variables = {
    HOME: path.join(root, "home"),
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_SUBAGENT_NAMES_FILE: "",
    PI_SUBAGENT_BUDGET_DIR: "",
    PI_SUBAGENT_DEPTH: "0",
    PI_SUBAGENT_STACK: "[]",
    PI_SUBAGENT_SESSION_ROOT: path.join(root, "sessions"),
    PI_SUBAGENT_DISABLE_RESUME: "true",
    DISABLE_RESUMABLE_SUBAGENTS: "false",
    PI_SUBAGENT_RUN_INTELLIGENCE: "null",
    PI_SUBAGENT_PI_COMMAND: process.execPath,
    PI_SUBAGENT_PI_ARGS_PREFIX: JSON.stringify([script]),
    PI_SUBAGENT_INTELLIGENCE: "true",
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  const host = createExtensionHarness();
  const parentBudget = createBudget(path.join(root, "budget"), 10);
  const budgets = reserveSubagentBudgets(
    parentBudget,
    "initial",
    [
      { agent: "retired-worker", task: "initial A", max_subagents_allowed: 1 },
      { agent: "retired-worker", task: "initial B", max_subagents_allowed: 1 },
    ],
    "main",
  );
  const namesFile = path.join(root, "names.json");
  const names = await allocateSubagentNames(
    namesFile,
    "root",
    budgets.map((budget, index) => {
      const sessionDir = path.join(root, "sessions", String(index));
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "session.jsonl"), JSON.stringify({ type: "session", id: String(index) }));
      return {
        agent: "retired-worker",
        task: "initial",
        sessionDir,
        budget,
        model: "saved/original",
        thinking: "high",
        intelligence: "senior",
      };
    }),
  );
  const entries = [
    customEntry(SUBAGENT_NAMES_CUSTOM_TYPE, { namesFile, ownerId: "root" }),
    customEntry(SUBAGENT_BUDGET_CUSTOM_TYPE, parentBudget),
  ];
  const ctx = host.makeCtx(entries, {
    cwd: root,
    hasUI: false,
    model: model("changed-parent", "different"),
    isProjectTrusted: () => true,
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
          .map((line) => JSON.parse(line))
      : [];
  const item = { subagent: names[0], task: "follow up", max_subagents_allowed: null };
  try {
    await host.emit("session_start", {}, ctx);
    const before = readBudget(parentBudget).remaining;
    for (const args of [
      { resumes: [{ ...item }, { ...item, subagent: names[1] }] },
      { resumes: [item] },
      { resumes: item },
      item,
      { resumes: [{ subagent: names[0], task: "omitted allowance" }] },
    ]) {
      const snapshot = structuredClone(args);
      const result = await host.call("resume_subagents", "valid", args, ctx);
      assert.equal(result.isError, false, JSON.stringify(result.content));
      assert.equal(
        result.details.results.length,
        "resumes" in args && Array.isArray(args.resumes) ? args.resumes.length : 1,
      );
      for (const resultItem of result.details.results) {
        assert.equal(resultItem.intelligence, "senior");
        assert.equal(resultItem.model, "saved/original");
        assert.equal(resultItem.thinking, "high");
      }
      assert.deepEqual(args, snapshot, "preparation must not mutate recorded model arguments");
      assert.equal(readBudget(parentBudget).remaining, before);
      for (const budget of budgets) assert.equal(readBudget(budget).limit, 1, "null means keep, never zero");
    }
    for (const invalid of [
      { ...item, subagent: null },
      { ...item, task: null },
      ...["senior", null, 7].map((intelligence) => ({ ...item, intelligence })),
      ...[-1, 1.5, "1", false, Number.MAX_SAFE_INTEGER].map((max_subagents_allowed) => ({
        ...item,
        max_subagents_allowed,
      })),
      { ...item, unknown: null },
    ]) {
      const beforeNames = fs.readFileSync(namesFile, "utf8");
      const beforeCalls = calls().length;
      const badSibling = invalid.subagent === null ? invalid : { ...invalid, subagent: names[1] };
      for (const args of [
        invalid,
        { resumes: invalid },
        { resumes: [invalid] },
        { resumes: [item, badSibling] },
        { resumes: [badSibling, item] },
      ]) {
        await assert.rejects(host.call("resume_subagents", "invalid", args, ctx), (error: Error) => {
          assert.match(error.message, /Invalid tool arguments/);
          assert.notEqual(error.message, "Assert");
          return true;
        });
      }
      assert.equal(calls().length, beforeCalls, "invalid batches must not spawn any worker");
      assert.equal(fs.readFileSync(namesFile, "utf8"), beforeNames, "invalid calls must not change names or markers");
      assert.equal(readBudget(parentBudget).remaining, before);
    }
    const zero = await host.call("resume_subagents", "zero", { resumes: [{ ...item, max_subagents_allowed: 0 }] }, ctx);
    assert.equal(zero.isError, false, JSON.stringify(zero.content));
    assert.equal(readBudget(budgets[0]).limit, 0, "explicit zero remains an override");
    assert.ok(
      calls().every(
        (call) =>
          call.args.includes("--session") && !call.args.includes("--continue") && call.intelligence === "senior",
      ),
    );
    assert.equal(readNamesRegistry(namesFile).agents[names[0]].intelligence, "senior");
  } finally {
    await host.emit("session_shutdown", {}, ctx);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
