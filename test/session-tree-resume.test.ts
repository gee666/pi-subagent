/**
 * Unfinished subagent recovery is offered only on session_start (startup or
 * resume), always behind a confirmation. Tree navigation never prompts or
 * resumes, and it cancels a pending startup confirmation or deferred resume.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";
import { buildSubagentDetails } from "../types.js";
import { createExtensionHarness as createHarness, messageEntry, model, resumeBranch } from "./helpers/extension.js";
import { serializedDetails } from "./helpers/json.js";
import { makeResult } from "./helpers/results.js";

type Harness = ReturnType<typeof createHarness>;

const unfinishedBranch = () => resumeBranch();
const finishedBranch = () => resumeBranch(true);
const RESUME_TEXT = "Resuming 2 subagents...";
const treeEvent = { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" } as const;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const switchedToResumeModel = (harness: Harness) =>
  harness.calls.setModel.some((value) => value.provider === RESUME_PROVIDER);

/** A confirmation the test answers later, standing in for a user who has not replied yet. */
function pendingConfirm(ctx: ExtensionContext) {
  const answers: Array<(value: boolean) => void> = [];
  ctx.ui.confirm = () =>
    new Promise<boolean>((resolve) => {
      answers.push(resolve);
    });
  return answers;
}

/** Ask the synthetic provider for a turn; armed recovery answers it with subagent tool calls. */
async function resumeToolCalls(harness: Harness): Promise<number> {
  const stream = harness.provider(RESUME_PROVIDER).streamSimple(
    model(RESUME_PROVIDER, RESUME_MODEL_ID, "openai-responses"),
    normalizeContext({
      messages: [{ role: "user", content: [{ type: "text", text: RESUME_TEXT }], timestamp: Date.now() }],
    }),
    {},
  );
  const response = await stream.result().catch(() => undefined);
  return response?.content.filter((part) => part.type === "toolCall").length ?? 0;
}

/** Ada finished; only Bo was interrupted. */
function partlyFinishedBranch(): SessionEntry[] {
  const tasks = [
    { agent: "worker", task: "do work" },
    { agent: "reviewer", task: "review work" },
  ];
  const results = [
    makeResult({ ...tasks[0], name: "Ada", finalOutput: "done" }),
    makeResult({
      ...tasks[1],
      name: "Bo",
      exitCode: 130,
      stderr: "aborted",
      stopReason: "aborted",
      errorMessage: "Subagent was aborted.",
    }),
  ];
  return [
    messageEntry(
      fauxAssistantMessage(
        { type: "toolCall", id: "call-1", name: "subagent", arguments: { tasks } },
        { stopReason: "toolUse" },
      ),
      "assistant-call-1",
    ),
    messageEntry(
      {
        role: "toolResult",
        toolName: "subagent",
        toolCallId: "call-1",
        content: [{ type: "text", text: "aborted" }],
        details: serializedDetails(buildSubagentDetails("parallel", "spawn", null, results)),
        isError: true,
        timestamp: Date.now(),
      },
      "result-call-1",
    ),
  ];
}

function assertNothingResumed(harness: Harness) {
  assert.equal(switchedToResumeModel(harness), false, "must not switch to the synthetic resume model");
  assert.deepEqual(harness.calls.sentUserMessages, []);
}

describe("startup subagent recovery", () => {
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
  });

  for (const reason of ["startup", "resume"] as const) {
    test(`asks first on ${reason}, then starts the deferred synthetic resume turn`, async (t) => {
      const harness = createHarness();
      const ctx = harness.makeCtx(unfinishedBranch());
      await harness.emit("session_start", { reason }, ctx);

      assert.equal(harness.calls.confirms, 1, "expected the resume confirmation prompt");
      const resumeModel = harness.calls.setModel.find((value) => value.provider === RESUME_PROVIDER);
      assert.equal(resumeModel?.id, RESUME_MODEL_ID);
      assert.deepEqual(harness.calls.sentUserMessages, [], "the visible prompt waits for resources_discover");
      t.mock.timers.enable({ apis: ["setTimeout"] });
      await harness.emit("resources_discover", {}, ctx);
      t.mock.timers.tick(200);
      assert.deepEqual(harness.calls.sentUserMessages, [RESUME_TEXT]);
      await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    });
  }

  // Pi resolves a dismissed, cancelled or timed-out confirm() as false.
  for (const answer of ["declined", "dismissed"] as const) {
    test(`a ${answer} confirmation leaves the plans, model and conversation untouched`, async (t) => {
      const harness = createHarness();
      const ctx = harness.makeCtx(unfinishedBranch());
      const answers = pendingConfirm(ctx);
      const startup = harness.emit("session_start", { reason: "resume" }, ctx);
      await wait(0);
      assert.equal(answers.length, 1);
      answers[0](false);
      await startup;

      t.mock.timers.enable({ apis: ["setTimeout"] });
      await harness.emit("resources_discover", {}, ctx);
      t.mock.timers.tick(200);
      assert.equal(harness.calls.setModel.length, 0);
      assert.deepEqual(harness.calls.sentUserMessages, []);
      assert.equal(await resumeToolCalls(harness), 0, "declined recovery must not arm the synthetic provider");
      await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    });
  }

  test("the confirmation names only the interrupted workers that would be recovered", async () => {
    const harness = createHarness();
    const ctx = harness.makeCtx(partlyFinishedBranch());
    const prompts: string[] = [];
    ctx.ui.confirm = async (_title, message) => {
      prompts.push(message);
      return false;
    };
    await harness.emit("session_start", { reason: "resume" }, ctx);

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Resume 1 interrupted subagent\b/);
    assert.match(prompts[0], /^- Bo \(reviewer\)$/m);
    assert.doesNotMatch(prompts[0], /Ada/, "finished workers are not offered for recovery");
    assertNothingResumed(harness);
    await harness.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  test("without a UI recovery is skipped instead of resuming silently", async (t) => {
    const harness = createHarness();
    const ctx = harness.makeCtx(unfinishedBranch(), { hasUI: false });
    await harness.emit("session_start", { reason: "resume" }, ctx);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await harness.emit("resources_discover", {}, ctx);
    t.mock.timers.tick(200);

    assert.equal(harness.calls.confirms, 0);
    assertNothingResumed(harness);
    assert.equal(await resumeToolCalls(harness), 0);
    await harness.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  for (const accept of [true, false]) {
    test(`RPC mode has a UI and asks before recovery (${accept ? "accepted" : "declined"})`, async () => {
      process.argv = [...originalArgv.slice(0, 2), "--mode", "rpc"];
      const harness = createHarness({ confirmAnswer: accept });
      const ctx = harness.makeCtx(unfinishedBranch(), { mode: "rpc" });
      await harness.emit("session_start", { reason: "resume" }, ctx);

      assert.equal(harness.calls.confirms, 1, "RPC clients answer confirm() over the UI protocol");
      assert.equal(switchedToResumeModel(harness), accept);
      if (!accept) assertNothingResumed(harness);
      await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    });
  }

  for (const reason of ["reload", "new", "fork"] as const) {
    test(`does not offer recovery on ${reason}`, async (t) => {
      const harness = createHarness();
      const ctx = harness.makeCtx(unfinishedBranch());
      await harness.emit("session_start", { reason }, ctx);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      await harness.emit("resources_discover", {}, ctx);
      t.mock.timers.tick(200);

      assert.equal(harness.calls.confirms, 0);
      assertNothingResumed(harness);
      await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    });
  }

  test("Pi abort cancels startup recovery while a synthetic-model switch is pending", async (t) => {
    const harness = createHarness();
    const ctx = harness.makeCtx(unfinishedBranch(), { abort() {} });
    let resumeSwitch!: () => void;
    let reachedSwitch!: () => void;
    const gate = new Promise<void>((resolve) => {
      resumeSwitch = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedSwitch = resolve;
    });
    const setModel = harness.pi.setModel;
    harness.pi.setModel = async (value) => {
      if (value.provider === RESUME_PROVIDER) {
        reachedSwitch();
        await gate;
      }
      return setModel(value);
    };
    const startup = harness.emit("session_start", { reason: "resume" }, ctx);
    await reached;
    await harness.emit("agent_settled", { aborted: true }, ctx);
    resumeSwitch();
    await startup;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await harness.emit("resources_discover", {}, ctx);
    t.mock.timers.tick(200);
    assert.deepEqual(harness.calls.sentUserMessages, []);
    assert.notEqual(harness.calls.setModel.at(-1)?.provider, RESUME_PROVIDER);
    await harness.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  test("Pi abort during the startup confirmation cancels recovery even if the user then accepts", async () => {
    const harness = createHarness();
    const ctx = harness.makeCtx(unfinishedBranch(), { abort() {} });
    const answers = pendingConfirm(ctx);
    const startup = harness.emit("session_start", { reason: "resume" }, ctx);
    await wait(0);
    assert.equal(answers.length, 1);
    await harness.emit("agent_settled", { aborted: true }, ctx);
    answers[0](true);
    await startup;

    assertNothingResumed(harness);
    await harness.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  test("cancels a deferred resume prompt when the session is replaced", async () => {
    const harness = createHarness();
    const ctx = harness.makeCtx(unfinishedBranch());
    await harness.emit("session_start", { reason: "resume" }, ctx);
    await harness.emit("resources_discover", {}, ctx);
    await harness.emit("session_shutdown", { reason: "resume" }, ctx);
    await wait(150);

    assert.deepEqual(harness.calls.sentUserMessages, []);
  });
});

describe("session_tree never recovers subagents", () => {
  afterEach(() => {
    delete process.env.PI_SUBAGENT_RESUME_PROMPT;
  });

  for (const legacyPrompt of [undefined, "false"]) {
    test(`navigating to an unfinished subagent point neither prompts nor resumes${legacyPrompt ? " with legacy PI_SUBAGENT_RESUME_PROMPT=false" : ""}`, async () => {
      if (legacyPrompt) process.env.PI_SUBAGENT_RESUME_PROMPT = legacyPrompt;
      const harness = createHarness();
      await harness.emit("session_start", { reason: "new" }, harness.makeCtx([]));
      const ctx = harness.makeCtx(unfinishedBranch());

      await harness.emit("session_tree", treeEvent, ctx);
      await wait(150);

      assert.equal(harness.calls.confirms, 0);
      assert.equal(harness.calls.setModel.length, 0);
      assert.deepEqual(harness.calls.sentUserMessages, []);
      assert.equal(await resumeToolCalls(harness), 0, "the provider must not rediscover plans from the branch");
      await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    });
  }

  test("navigating to a finished branch does nothing", async () => {
    const harness = createHarness();
    await harness.emit("session_start", { reason: "new" }, harness.makeCtx([]));
    const ctx = harness.makeCtx(finishedBranch());

    await harness.emit("session_tree", treeEvent, ctx);
    await wait(120);

    assert.equal(harness.calls.confirms, 0);
    assert.equal(harness.calls.setModel.length, 0);
    assert.deepEqual(harness.calls.sentUserMessages, []);
  });

  test("navigation during the startup confirmation cancels recovery even if the user then accepts", async () => {
    const harness = createHarness();
    const ctx = harness.makeCtx(unfinishedBranch());
    const answers = pendingConfirm(ctx);
    const startup = harness.emit("session_start", { reason: "resume" }, ctx);
    await wait(0);
    assert.equal(answers.length, 1);
    await harness.emit("session_tree", treeEvent, ctx);
    assert.equal(answers.length, 1, "navigation must not open a second confirmation");
    answers[0](true);
    await startup;
    await harness.emit("resources_discover", {}, ctx);
    await wait(150);

    assertNothingResumed(harness);
    assert.equal(await resumeToolCalls(harness), 0);
    await harness.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  for (const stage of ["before resources_discover", "after resources_discover"] as const) {
    test(`navigation cancels an accepted startup resume ${stage}`, async (t) => {
      const harness = createHarness();
      const ctx = harness.makeCtx(unfinishedBranch());
      await harness.emit("session_start", { reason: "resume" }, ctx);
      assert.equal(harness.calls.confirms, 1);
      assert.ok(switchedToResumeModel(harness));

      t.mock.timers.enable({ apis: ["setTimeout"] });
      if (stage === "after resources_discover") await harness.emit("resources_discover", {}, ctx);
      await harness.emit("session_tree", treeEvent, ctx);
      if (stage === "before resources_discover") await harness.emit("resources_discover", {}, ctx);
      t.mock.timers.tick(200);

      assert.deepEqual(harness.calls.sentUserMessages, []);
      assert.notEqual(harness.calls.setModel.at(-1)?.provider, RESUME_PROVIDER, "the real model is restored");
      assert.equal(harness.calls.confirms, 1);
      assert.equal(await resumeToolCalls(harness), 0, "canceled recovery must disarm the synthetic provider");
      await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    });
  }
});
