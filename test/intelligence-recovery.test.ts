import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, hostDouble, messageEntry, model } from "./helpers/extension.js";
import { parseIntelligencePresets } from "../intelligence.js";
import {
  createIntelligenceSchemas,
  findRecoveryPlanIndex,
  normalizeRecoveryIntelligence,
  prepareRecoveryArguments,
  validatePreparedArguments,
} from "../extension/schemas.js";
import { findPersistedBudget, readBudget } from "../budget.js";
import { getFinalOutput } from "../types.js";
import { serializedDetails } from "./helpers/json.js";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";

const originalEnabled = process.env.PI_SUBAGENT_INTELLIGENCE;
before(() => {
  process.env.PI_SUBAGENT_INTELLIGENCE = "true";
});
after(() => {
  if (originalEnabled === undefined) delete process.env.PI_SUBAGENT_INTELLIGENCE;
  else process.env.PI_SUBAGENT_INTELLIGENCE = originalEnabled;
});

const settings = [
  { old: { model: "old-model", provider: "old-provider", "reasoning-level": "low" } },
  { sole: { model: "new-model", provider: "new-provider", "reasoning-level": "high" } },
];
const presets = parseIntelligencePresets(settings);
const savedTask = { agent: "worker", task: "saved work", intelligence: "old", max_subagents_allowed: 0 };

test("only matching recovery plans may omit hidden intelligence; multiple presets keep explicit choices", () => {
  const plans = [{ previousToolCallId: "saved-id", tasks: [savedTask] }];
  const snapshot = structuredClone(plans);
  const { intelligence: _intelligence, ...omitted } = savedTask;
  for (const current of [[], [presets[1]], presets]) {
    const schema = createIntelligenceSchemas(current).subagents;
    const prepared = prepareRecoveryArguments({ tasks: [savedTask] }, plans, current);
    validatePreparedArguments(schema, prepared);
    const expected = current.length === 2 ? savedTask : omitted;
    assert.deepEqual(prepared, { tasks: [expected] });
    assert.equal(findRecoveryPlanIndex([expected], plans, current), 0);
    assert.equal(findRecoveryPlanIndex([{ ...expected, task: "different" }], plans, current), -1);
    assert.equal(findRecoveryPlanIndex([{ ...savedTask, intelligence: "sole" }], plans, current), -1);
    if (current.length < 2) {
      assert.throws(() =>
        validatePreparedArguments(schema, prepareRecoveryArguments({ tasks: [savedTask] }, [], current)),
      );
      for (const args of [
        { tasks: [{ ...savedTask, task: "different" }] },
        { tasks: [{ ...savedTask, intelligence: "sole" }] },
        { tasks: [{ ...savedTask, max_subagents_allowed: 1 }] },
      ]) {
        assert.throws(() => validatePreparedArguments(schema, prepareRecoveryArguments(args, plans, current)));
      }
    }
  }
  const previous = process.env.PI_SUBAGENT_INTELLIGENCE;
  try {
    process.env.PI_SUBAGENT_INTELLIGENCE = "false";
    assert.deepEqual(normalizeRecoveryIntelligence([savedTask], presets), [omitted]);
    validatePreparedArguments(
      createIntelligenceSchemas(presets).subagents,
      prepareRecoveryArguments({ tasks: [savedTask] }, plans, presets),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_INTELLIGENCE;
    else process.env.PI_SUBAGENT_INTELLIGENCE = previous;
  }
  assert.deepEqual(plans, snapshot, "saved recovery identity is never rewritten");
});

test("saved explicit choice recovers through the provider and tool with sole, zero, or disabled presets", async () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/intelligence-recovery-"));
  const script = path.join(root, "fake-pi.cjs");
  fs.writeFileSync(
    script,
    `const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2), session = args[args.indexOf('--session-dir') + 1];
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      if (JSON.parse(line).type !== 'prompt') return;
      fs.mkdirSync(session, { recursive: true });
      fs.writeFileSync(path.join(session, 'session.jsonl'), JSON.stringify({ type: 'session', id: 'worker' }) + '\\n');
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(args) }], stopReason: 'stop' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    });`,
  );
  const variables = {
    HOME: path.join(root, "home"),
    PI_CODING_AGENT_DIR: path.join(root, "user"),
    PI_SUBAGENT_INTELLIGENCE: "true",
    PI_SUBAGENT_RUN_INTELLIGENCE: "null",
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
  fs.mkdirSync(path.join(root, ".pi/agents"), { recursive: true });
  fs.mkdirSync(variables.PI_CODING_AGENT_DIR);
  fs.writeFileSync(path.join(root, ".pi/agents/worker.md"), "---\nname: worker\ndescription: worker\n---\nWork.\n");
  const config = path.join(root, ".pi/pi-subagent.json");
  fs.writeFileSync(config, JSON.stringify({ "subagents-models": settings }));
  const entries: SessionEntry[] = [];
  const context = (host: ReturnType<typeof createExtensionHarness>) =>
    host.makeCtx(entries, {
      cwd: root,
      hasUI: false,
      isProjectTrusted: () => true,
      model: model("parent", "live"),
      sessionManager: hostDouble<ExtensionContext["sessionManager"]>({
        getEntries: () => entries,
        getBranch: () => entries,
        getLeafId: () => entries.at(-1)?.id ?? null,
        getSessionId: () => "root",
        getSessionDir: () => path.join(root, "sessions"),
        getHeader: () => null,
      }),
    });
  const first = createExtensionHarness();
  const firstCtx = context(first);
  try {
    await first.emit("session_start", {}, firstCtx);
    const launched = await first.call("subagents", "saved-id", { tasks: [savedTask] }, firstCtx);
    assert.equal(launched.isError, false, JSON.stringify(launched.content));
    const saved = launched.details.results[0];
    assert.ok(saved.name);
    assert.ok(saved.sessionDir);
    entries.push(
      messageEntry(
        fauxAssistantMessage({
          type: "toolCall",
          id: "saved-id",
          name: "subagents",
          arguments: { tasks: [savedTask] },
        }),
        "saved-call",
      ),
      messageEntry(
        {
          role: "toolResult",
          toolName: "subagents",
          toolCallId: "saved-id",
          content: [{ type: "text", text: "interrupted" }],
          details: serializedDetails({
            ...launched.details,
            results: [{ ...saved, exitCode: 130, stopReason: "aborted" }],
          }),
          isError: true,
          timestamp: Date.now(),
        },
        "saved-result",
      ),
    );
    await first.emit("session_shutdown", {}, firstCtx);
    const budget = findPersistedBudget(entries)!;
    const remaining = readBudget(budget).remaining;
    assert.equal(remaining, 9);
    for (const [current, enabled, expected] of [
      [[settings[1]], "true", "sole"],
      [[], "true", undefined],
      [settings, "false", undefined],
    ] as const) {
      fs.writeFileSync(config, JSON.stringify({ "subagents-models": current }));
      process.env.PI_SUBAGENT_INTELLIGENCE = enabled;
      const host = createExtensionHarness();
      const ctx = context(host);
      try {
        await host.emit("session_start", {}, ctx);
        await assert.rejects(host.call("subagents", "ordinary", { tasks: [savedTask] }, ctx));
        const stream = host.provider(RESUME_PROVIDER).streamSimple(
          model(RESUME_PROVIDER, RESUME_MODEL_ID, "openai-responses"),
          normalizeContext({
            messages: [
              { role: "user", content: [{ type: "text", text: "Resuming 1 subagents..." }], timestamp: Date.now() },
            ],
          }),
          {},
        );
        const message = await stream.result();
        const call = message.content.find((block) => block.type === "toolCall");
        assert.ok(call?.type === "toolCall");
        assert.deepEqual(call.arguments, {
          tasks: [{ agent: "worker", task: "saved work", max_subagents_allowed: 0 }],
        });
        // Also cover argument preparation of old saved arguments, not just normalized provider output.
        const recovered = await host.call(
          "subagents",
          call.id,
          expected ? call.arguments : { tasks: [savedTask] },
          ctx,
        );
        assert.equal(recovered.isError, false, JSON.stringify(recovered.content));
        const result = recovered.details.results[0];
        assert.equal(result.intelligence, expected);
        assert.equal(result.name, saved.name);
        assert.equal(result.sessionDir, saved.sessionDir);
        assert.deepEqual(result.budget, saved.budget);
        assert.equal(readBudget(budget).remaining, remaining, "recovery must not reserve a fresh branch");
        const args = JSON.parse(getFinalOutput(result.messages, result.finalOutput)) as string[];
        assert.equal(args.includes("--continue"), false);
        assert.equal(args[args.indexOf("--session") + 1], path.join(saved.sessionDir, "session.jsonl"));
        assert.equal(args[args.indexOf("--model") + 1], expected ? "new-model" : "parent/live");
        assert.equal(args.includes("--provider"), !!expected);
        if (expected) {
          assert.equal(args[args.indexOf("--provider") + 1], "new-provider");
          assert.equal(args[args.indexOf("--thinking") + 1], "high");
        }
        assert.equal(saved.intelligence, "old");
      } finally {
        await host.emit("session_shutdown", {}, ctx);
      }
    }
  } finally {
    await first.emit("session_shutdown", {}, firstCtx);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
