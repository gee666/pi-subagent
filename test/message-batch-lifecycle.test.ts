import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { allocateSubagentNames, readNamesRegistry } from "../names.js";
import { readBudget, reserveSubagentBudgets } from "../budget.js";
import { describeToolArgs } from "../detail.js";
import { fixture, gatedRunner, until, assertSuccess } from "./helpers/message-subagent.js";
import { hostDouble } from "./helpers/extension.js";

type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
const theme = hostDouble<Theme>({ fg: (_color, text) => text, bold: (text) => text });

test(
  "batch resumes own separate sessions, apply each quota, and complete independently without leaking recipients",
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    try {
      const runner = gatedRunner(f);
      const [otherBudget] = reserveSubagentBudgets(f.state.currentBudget!, "other", [
        { agent: "reviewer", task: "original", max_subagents_allowed: 2 },
      ]);
      const sessionDir = path.join(f.root, "other-session");
      fs.mkdirSync(sessionDir);
      fs.writeFileSync(path.join(sessionDir, "session.jsonl"), JSON.stringify({ type: "session", id: "other" }) + "\n");
      const [otherName] = await allocateSubagentNames(f.state.currentNamesFile, f.state.currentOwnerId, [
        {
          agent: "reviewer",
          task: "original",
          sessionDir,
          budget: otherBudget,
          model: "original/provider-model",
          thinking: "high",
          intelligence: "junior",
        },
      ]);
      const completions: Array<{ content: unknown; details?: unknown }> = [];
      f.state.pi.sendMessage = (message) => {
        completions.push(message);
      };
      const args = { name: [f.name, otherName], message: "Shared change\nKeep this exact.", max_subagents_allowed: 4 };
      const result = await f.execute(args);
      assertSuccess(result);
      assert.equal(f.state.backgroundJobs.size, 2);
      assert.equal(readBudget(f.budget).limit, 4);
      assert.equal(readBudget(otherBudget).limit, 4);
      assert.equal(readBudget(f.state.currentBudget!).remaining, 2);
      await until(() => runner.runs().length === 2);
      assert.deepEqual(
        runner.runs().map((run) => run.prompt),
        [args.message, args.message],
      );
      const ctx = hostDouble<RenderContext>({ args, state: {}, isError: false });
      const header = f.tool.renderCall!(args, theme, ctx).render(160).join("\n");
      const body = f.tool.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx)
        .render(160)
        .join("\n");
      for (const screen of [header, body]) {
        assert.ok(screen.includes(`${f.name} (Old-label/removed-worker)`), screen);
        assert.ok(screen.includes(`${otherName} (Junior/reviewer)`), screen);
      }
      runner.release();
      await until(() => completions.length === 2);
      await Promise.all(Array.from(f.state.backgroundJobs.values(), (job) => job.promise));
      assert.equal(f.state.activeResumeNames.size, 0);
      assert.equal(f.state.backgroundJobs.size, 0);
      assert.equal(f.state.forcedErrorToolCallIds.size, 0);
      const registry = readNamesRegistry(f.state.currentNamesFile);
      for (const name of args.name)
        assert.equal(registry.agents[name].activeResumes?.[f.state.currentOwnerId], undefined);
      assert.notDeepEqual(completions[0].details, completions[1].details);
    } finally {
      await f.close();
    }
  },
);

test("batch errors identify the failing recipient without hiding the successful recipient's preview", async () => {
  const f = await fixture();
  try {
    f.running(() => true);
    f.state.activeSubagents.set(2, {
      name: "Bob",
      agent: "",
      task: "work",
      handle: {
        steer() {
          throw new Error("RPC transport closed");
        },
      },
    });
    const args = { name: [f.name, "Bob"], message: "Shared instruction" };
    const result = await f.execute(args);
    const ctx = hostDouble<RenderContext>({ args, state: {}, isError: true });
    const screen = f.tool.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx)
      .render(160)
      .join("\n");
    assert.match(screen, /Bob: RPC transport closed/);
    assert.match(screen, /Shared instruction/);
    assert.match(screen, /Old-label\/removed-worker/);
    assert.equal(
      describeToolArgs("message_subagent", { name: ["Alice", "Bob"], message: "hello" }),
      "Alice, Bob: hello",
    );
  } finally {
    await f.close();
  }
});
