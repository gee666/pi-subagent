import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { settingsFixture } from "./helpers/settings.js";

test("SDK-loaded tools preserve named-child ownership and spent budget across a session reload", () => {
  const f = settingsFixture();
  const repo = process.cwd();
  const log = path.join(f.root, "runs.jsonl");
  const worker = path.join(f.root, "worker.cjs");
  // Only the worker's RPC peer is simulated; no provider or model request is made.
  fs.writeFileSync(
    worker,
    `const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
const flag = key => args[args.indexOf(key) + 1];
const dir = args.includes('--session-dir') ? flag('--session-dir') : path.dirname(flag('--session'));
fs.mkdirSync(dir, { recursive: true });
const session = path.join(dir, 'session.jsonl');
if (!fs.existsSync(session)) fs.writeFileSync(session, JSON.stringify({ type: 'session', id: 'saved-worker' }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type !== 'prompt') return;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, message: request.message, budget: process.env.PI_SUBAGENT_BUDGET_DIR }) + '\\n');
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }], stopReason: 'stop' } }));
  console.log(JSON.stringify({ type: 'agent_settled' }));
});`,
  );
  fs.mkdirSync(path.join(f.project, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(f.project, ".pi", "agents", "evergreen.md"),
    "---\nname: evergreen-worker\ndescription: Integration worker\n---\nPerform the task.\n",
  );
  f.write(f.agent, {
    limits: { total: 2 },
    runner: { command: process.execPath, argsPrefix: [worker] },
  });
  try {
    // Pi's loader provides its TypeBox aliases. Isolate it from tsx's module cache
    // and use the existing host/context helpers only at the application boundary.
    const code = `
      import assert from 'node:assert/strict';
      import * as fs from 'node:fs';
      import * as path from 'node:path';
      import { validateToolArguments } from '@earendil-works/pi-ai';
      import { createExtensionHarness, customEntry, hostDouble } from './test/helpers/extension.ts';
      import { until, assertSuccess, text } from './test/helpers/message-subagent.ts';
      import { findPersistedBudget, readBudget } from './budget.ts';
      import { readNamesRegistry, SUBAGENT_NAMES_CUSTOM_TYPE } from './names.ts';
      import { isSubagentDetails } from './types.ts';
      import { simulatedTreeWorker } from './test/helpers/tree-concurrency.ts';
      const { loadExtensions } = await import(new URL('./core/extensions/loader.js',
        import.meta.resolve('@earendil-works/pi-coding-agent')));
      const root = ${JSON.stringify(f.root)}, cwd = ${JSON.stringify(f.project)};
      const namesFile = path.join(root, 'names.json');
      const tree = simulatedTreeWorker(path.join(root, 'concurrency'));
      Object.assign(process.env, tree.env);
      const opened = [];
      let callId = 0;
      async function open(id, entries) {
        const host = createExtensionHarness();
        const ctx = host.makeCtx(entries, {
          cwd, hasUI: false, isProjectTrusted: () => true,
          sessionManager: hostDouble({
            getEntries: () => entries, getBranch: () => entries, getLeafId: () => null,
            getSessionId: () => id, getSessionDir: () => path.join(root, 'sessions', id),
            getSessionFile: () => undefined, getHeader: () => null,
          }),
        });
        const loaded = await loadExtensions([${JSON.stringify(path.join(repo, "index.ts"))}], cwd);
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        for (const key of ['appendEntry', 'sendMessage', 'sendUserMessage', 'getActiveTools', 'setActiveTools', 'setModel']) {
          loaded.runtime[key] = host.pi[key];
        }
        const extension = loaded.extensions[0];
        async function emit(type, fields = {}) {
          for (const handler of extension.handlers.get(type) ?? []) await handler({ type, ...fields }, ctx);
        }
        const instance = {
          host, entries, emit,
          async call(name, args) {
            const tool = extension.tools.get(name)?.definition;
            assert.ok(tool, name + ' must remain registered');
            const prepared = tool.prepareArguments(args);
            const id = 'evergreen-' + ++callId;
            const validated = validateToolArguments(tool, { type: 'toolCall', id, name, arguments: prepared });
            return tool.execute(id, validated, undefined, undefined, ctx);
          },
        };
        opened.push(instance);
        await emit('session_start', { reason: 'startup' });
        return instance;
      }
      const runs = () => fs.existsSync(${JSON.stringify(log)})
        ? fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').map(line => JSON.parse(line)) : [];
      async function completion(instance, before) {
        await until(() => instance.host.calls.sentMessages.length > before);
        const { message, options } = instance.host.calls.sentMessages.at(-1);
        assert.equal(message.customType, 'subagent_completion');
        assert.deepEqual(options, { deliverAs: 'steer', triggerTurn: true });
        assert.ok(isSubagentDetails(message.details));
        const result = message.details.results[0];
        assert.equal(result.exitCode, 0);
        return result;
      }
      try {
        const entries = [customEntry(SUBAGENT_NAMES_CUSTOM_TYPE, { namesFile, ownerId: 'durable-owner' })];
        const lead = await open('original-session', entries);
        const launched = await lead.call('subagents', { tasks: [{ agent: 'evergreen-worker', task: 'implement the change', max_subagents_allowed: 1 }] });
        assertSuccess(launched);
        assert.ok(isSubagentDetails(launched.details));
        const pending = launched.details.results[0];
        assert.ok(pending.name && pending.budget);
        assert.equal(pending.exitCode, -1, 'launch is nonblocking');
        const finished = await completion(lead, 0);
        assert.equal(finished.name, pending.name);
        const budget = findPersistedBudget(entries);
        assert.ok(budget);
        assert.equal(readBudget(budget).remaining, 0);
        assert.equal(readBudget(pending.budget).remaining, 1);
        await lead.emit('session_shutdown', { reason: 'quit' });

        // A shared registry alone must not confer ownership or permit a budget increase.
        const foreign = await open('other-session', [customEntry(SUBAGENT_NAMES_CUSTOM_TYPE,
          { namesFile, ownerId: 'other-owner' })]);
        const denied = await foreign.call('message_subagent', {
          name: pending.name, message: 'not yours', max_subagents_allowed: 2,
        });
        assert.equal(denied.isError, true);
        assert.match(text(denied), /direct children/);
        assert.equal(runs().length, 1);
        assert.equal(readBudget(pending.budget).remaining, 1);

        // Pi changes session ids on reopen; persisted identity and allowance must win.
        const reopened = await open('replacement-session-id', [...entries]);
        const exhausted = await reopened.call('subagents', { tasks: [{ agent: 'evergreen-worker', task: 'extra worker', max_subagents_allowed: 0 }] });
        assert.equal(exhausted.isError, true);
        assert.match(text(exhausted), /has 0 slots left/);
        const before = reopened.host.calls.sentMessages.length;
        const resumed = await reopened.call('message_subagent', { name: pending.name, message: 'now verify the change' });
        assertSuccess(resumed);
        assert.equal((await completion(reopened, before)).name, pending.name);
        assert.equal(readBudget(budget).remaining, 0, 'resume consumes no new worker slot');
        assert.equal(readBudget(pending.budget).remaining, 1);
        const history = runs();
        assert.equal(history.length, 2);
        assert.equal(history[1].message, 'now verify the change');
        assert.ok(history[1].args.includes('--session'), 'resume uses the saved worker context');
        assert.ok(!history[1].args.includes('--no-session'));
        assert.equal(history[1].budget, pending.budget.directory);
        const registry = readNamesRegistry(namesFile);
        assert.deepEqual(Object.keys(registry.agents), [pending.name]);
        assert.equal(registry.agents[pending.name].ownerSessionId, 'durable-owner');
        assert.deepEqual(registry.agents[pending.name].budget, pending.budget);
        console.log('durable delegation, ownership, reload, resume and budget verified');
      } finally {
        for (const instance of opened.reverse()) await instance.emit('session_shutdown', { reason: 'quit' });
        tree.close();
      }
    `;
    const output = execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], {
      cwd: repo,
      encoding: "utf8",
      timeout: 240000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_SUBAGENT_INTELLIGENCE: "false",
        PI_SUBAGENT_MAX_TOTAL_AGENTS: "2",
        PI_SUBAGENT_CONFIRM_PROJECT_AGENTS: "false",
        JITI_CACHE_DIR: path.join(f.root, "jiti"),
      },
    });
    assert.match(output, /durable delegation, ownership, reload, resume and budget verified/);
  } finally {
    f.close();
  }
});
