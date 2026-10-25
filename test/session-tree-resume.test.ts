/**
 * Verifies that navigating the session tree in the TUI (Esc navigation) back
 * to a point with an unfinished subagent call offers to resume the subagents,
 * mirroring the session_start resume behavior.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";
import type { TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness as createHarness, resumeBranch } from "./helpers/extension.js";

const unfinishedBranch = () => resumeBranch();
const finishedBranch = () => resumeBranch(true);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("session_tree subagent resume", () => {
  test("Escape is active while startup recovery awaits a synthetic-model switch", async (t) => {
    const harness = createHarness();
    let input: TerminalInputHandler | undefined;
    const ctx = harness.makeCtx(unfinishedBranch(), { abort() {} });
    ctx.ui.onTerminalInput = (handler) => {
      input = handler;
      return () => {
        input = undefined;
      };
    };
    let resumeSwitch!: () => void;
    let reachedSwitch!: () => void;
    const gate = new Promise<void>((resolve) => {
      resumeSwitch = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedSwitch = resolve;
    });
    const setModel = harness.pi.setModel;
    harness.pi.setModel = async (model) => {
      if (model.provider === RESUME_PROVIDER) {
        reachedSwitch();
        await gate;
      }
      return setModel(model);
    };
    const startup = harness.emit("session_start", { reason: "resume" }, ctx);
    await reached;
    assert.ok(input, "Escape listener must be installed before startup recovery awaits");
    input("\u001b");
    resumeSwitch();
    await startup;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await harness.emit("resources_discover", {}, ctx);
    t.mock.timers.tick(200);
    assert.deepEqual(harness.calls.sentUserMessages, []);
    assert.notEqual(harness.calls.setModel.at(-1)?.provider, RESUME_PROVIDER);
    await harness.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  for (const duringConfirmation of [false, true]) {
    test(`Escape cancels automatic resume ${duringConfirmation ? "during confirmation" : "before the delayed prompt"}`, async (t) => {
      const harness = createHarness();
      let input: TerminalInputHandler | undefined;
      const start = harness.makeCtx([], { abort() {} });
      start.ui.onTerminalInput = (handler) => {
        input = handler;
        return () => {
          input = undefined;
        };
      };
      await harness.emit("session_start", { reason: "new" }, start);
      assert.ok(input);
      const ctx = harness.makeCtx(unfinishedBranch(), { abort() {} });
      let confirm!: (value: boolean) => void;
      if (duringConfirmation)
        ctx.ui.confirm = () =>
          new Promise<boolean>((resolve) => {
            confirm = resolve;
          });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const navigation = harness.emit(
        "session_tree",
        { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" },
        ctx,
      );
      if (duringConfirmation) {
        assert.ok(confirm);
        input("\u001b");
        confirm(true);
        await navigation;
      } else {
        await navigation;
        assert.ok(harness.calls.setModel.some((model) => model.provider === RESUME_PROVIDER));
        input("\u001b");
      }
      t.mock.timers.tick(200);
      assert.deepEqual(harness.calls.sentUserMessages, []);
      if (duringConfirmation) assert.equal(harness.calls.setModel.length, 0);
      else assert.notEqual(harness.calls.setModel.at(-1)?.provider, RESUME_PROVIDER);
      await harness.emit("session_shutdown", { reason: "quit" }, ctx);
    });
  }

  test("offers resume and starts the synthetic resume turn after navigating to an unfinished subagent point", async () => {
    const harness = createHarness();
    await harness.emit("session_start", { reason: "new" }, harness.makeCtx([]));
    const ctx = harness.makeCtx(unfinishedBranch());

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" }, ctx);
    await wait(150);

    assert.equal(harness.calls.confirms, 1, "expected the resume confirmation prompt");
    const resumeModel = harness.calls.setModel.find((m) => m?.provider === RESUME_PROVIDER);
    assert.ok(resumeModel, "expected a switch to the synthetic resume model");
    assert.equal(resumeModel.id, RESUME_MODEL_ID);
    assert.deepEqual(harness.calls.sentUserMessages, ["Resuming 2 subagents..."]);
  });

  test("ignores extension-driven tree navigation", async () => {
    const harness = createHarness();
    await harness.emit("session_start", { reason: "new" }, harness.makeCtx([]));
    const ctx = harness.makeCtx(unfinishedBranch());

    await harness.emit(
      "session_tree",
      { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x", fromExtension: true },
      ctx,
    );
    await wait(120);

    assert.equal(harness.calls.confirms, 0);
    assert.equal(harness.calls.setModel.length, 0);
    assert.deepEqual(harness.calls.sentUserMessages, []);
  });

  test("does nothing when the navigated branch has no unfinished subagent call", async () => {
    const harness = createHarness();
    await harness.emit("session_start", { reason: "new" }, harness.makeCtx([]));
    const ctx = harness.makeCtx(finishedBranch());

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" }, ctx);
    await wait(120);

    assert.equal(harness.calls.confirms, 0);
    assert.equal(harness.calls.setModel.length, 0);
    assert.deepEqual(harness.calls.sentUserMessages, []);
  });

  test("declining the resume prompt leaves the model and conversation untouched", async () => {
    const harness = createHarness({ confirmAnswer: false });
    await harness.emit("session_start", { reason: "new" }, harness.makeCtx([]));
    const ctx = harness.makeCtx(unfinishedBranch());

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" }, ctx);
    await wait(120);

    assert.equal(harness.calls.confirms, 1);
    assert.equal(harness.calls.setModel.length, 0);
    assert.deepEqual(harness.calls.sentUserMessages, []);
  });

  test("does not offer resume while the agent is busy", async () => {
    const harness = createHarness();
    await harness.emit("session_start", { reason: "new" }, harness.makeCtx([]));
    const ctx = harness.makeCtx(unfinishedBranch(), { isIdle: () => false });

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" }, ctx);
    await wait(120);

    assert.equal(harness.calls.confirms, 0);
    assert.deepEqual(harness.calls.sentUserMessages, []);
  });

  test("cancels a delayed resume prompt when the session is replaced", async () => {
    const harness = createHarness();
    await harness.emit("session_start", { reason: "new" }, harness.makeCtx([]));
    const ctx = harness.makeCtx(unfinishedBranch());

    await harness.emit("session_tree", { type: "session_tree", newLeafId: "result-call-1", oldLeafId: "x" }, ctx);
    await harness.emit("session_shutdown", { reason: "resume" }, ctx);
    await wait(120);

    assert.deepEqual(harness.calls.sentUserMessages, []);
  });
});
