import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatNameSuffix } from "../extension/execution.js";
import { executeParallelSubprocess } from "../runner/parallel.js";
import { buildSubagentDetails } from "../types.js";
import { makeResult } from "./helpers/results.js";
import { createExtensionHarness } from "./helpers/extension.js";
import { settingsFixture } from "./helpers/settings.js";

const cases = [
  { name: "Margaret", agent: "writer", intelligence: "senior", label: "Margaret (Senior/writer)" },
  { name: "Margaret", agent: "", intelligence: "senior", label: "Margaret (Senior)" },
  { name: "Margaret", agent: "writer", intelligence: undefined, label: "Margaret (writer)" },
  { name: "Margaret", agent: "", intelligence: undefined, label: "Margaret" },
  { name: undefined, agent: "", intelligence: "senior", label: "Senior" },
  { name: undefined, agent: "", intelligence: undefined, label: "subagent" },
];
const makeDetails = (results: Parameters<typeof buildSubagentDetails>[3]) =>
  buildSubagentDetails("parallel", "spawn", null, results);

test("single response name suffixes retain intelligence and omit empty type parentheses", () => {
  for (const { name, agent, intelligence, label } of cases) {
    assert.equal(
      formatNameSuffix(makeResult({ name, agent, intelligence })),
      name ? `\n\n(subagent: ${label} — resume with the name ${name})` : "",
    );
  }
  assert.equal(formatNameSuffix(undefined), "");
});

test("parallel success and failure responses share optional identity qualifiers", async () => {
  const f = settingsFixture();
  try {
    for (const failed of [false, true]) {
      for (const { name, agent, intelligence, label } of cases) {
        const previous = makeResult({ name, agent, intelligence, finalOutput: "Done.", exitCode: failed ? 1 : 0 });
        const response = await executeParallelSubprocess(
          [{ agent, task: "Work" }],
          agent ? [{ name: agent, description: "", systemPrompt: "", source: "user", filePath: "" }] : [],
          f.project,
          0,
          3,
          [],
          false,
          AbortSignal.abort(),
          undefined,
          makeDetails,
          [previous],
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          { settings: {}, names: [name], resumeSettings: [{ intelligence }] },
        );
        const identity = name || agent || intelligence ? `[${label}]` : label;
        assert.equal(
          response.content[0].text,
          `Parallel: ${failed ? 0 : 1}/1 succeeded\n\n${identity} ${failed ? "failed: Subagent was aborted." : "completed: Done."}`,
        );
        assert.doesNotMatch(response.content[0].text, /\(\)|\[\]|Senior\/\)/);
        assert.equal(response.isError, failed ? true : undefined);
      }
    }
  } finally {
    f.close();
  }
});

test("legacy resume-disable env and JSON preserve names, messaging tools and prompt guidance on failed launches", async () => {
  const f = settingsFixture();
  const script = path.join(f.root, "failure.cjs");
  fs.writeFileSync(
    script,
    `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      if (JSON.parse(line).type !== 'prompt') return;
      console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
        content: [], stopReason: 'error', errorMessage: 'Failed task.' } }));
      console.log(JSON.stringify({ type: 'agent_settled' }));
    });`,
  );
  try {
    for (const legacyDisabled of ["false", "true"]) {
      for (const intelligence of [undefined, "senior"]) {
        process.env.DISABLE_RESUMABLE_SUBAGENTS = legacyDisabled;
        f.write(f.agent, {
          runner: { command: process.execPath, argsPrefix: [script] },
          limits: { total: 4 },
          resume: { disabled: true, disableAuto: true },
          ...(intelligence
            ? { "subagents-models": [{ senior: { model: "test", provider: "local", "reasoning-level": "off" } }] }
            : {}),
        });
        const host = createExtensionHarness();
        const ctx = host.makeCtx([], { cwd: f.project, hasUI: false });
        try {
          await host.emit("session_start", {}, ctx);
          assert.ok(host.getActiveTools().includes("subagents"));
          assert.ok(host.getActiveTools().includes("message_subagent"));
          const prompt = (await host.emit("before_agent_start", {}, ctx)).at(-1) as { systemPrompt: string };
          assert.match(prompt.systemPrompt, /durable worker names/);
          assert.match(prompt.systemPrompt, /Use `message_subagent`/);
          const response = await host.callAndWait(
            "subagents",
            "failed-call",
            { tasks: [{ task: "Fail", max_subagents_allowed: 0 }] },
            ctx,
          );
          const result = response.details.results[0];
          assert.equal(result.agent, "");
          assert.equal(result.intelligence, intelligence);
          assert.ok(result.name, "workers always receive durable names");
          assert.equal(response.started.isError, false, "launch acknowledges work before it fails");
          assert.equal(response.started.details.results[0].exitCode, -1);
          assert.equal(response.started.details.results[0].name, result.name);
          assert.equal(response.content[0].text, `Subagent ${result.name} failed:\nFailed task.`);
          assert.equal(result.errorMessage, "Failed task.");
          assert.equal(response.isError, true);
          assert.doesNotMatch(response.content[0].text, /\(\)|Senior\//);
        } finally {
          await host.emit("session_shutdown", {}, ctx);
        }
      }
    }
  } finally {
    f.close();
  }
});
