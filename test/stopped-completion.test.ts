import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { publishCompletion } from "../extension/completion.js";
import { registerAsyncDeliveryEvents } from "../extension/async-jobs.js";
import { createExtensionState } from "../extension/state.js";
import { persistWorkerStops } from "../storage/worker-stops.js";
import { compactSingleResultForDurableDetails, emptyUsage, getNestedSubagentResults } from "../types.js";
import { createExtensionHarness, messageEntry } from "./helpers/extension.js";
import { serializedDetails } from "./helpers/json.js";
import { makeResult } from "./helpers/results.js";
import { settingsFixture } from "./helpers/settings.js";
import { until } from "./helpers/message-subagent.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function setup() {
  const f = settingsFixture();
  const host = createExtensionHarness();
  const state = createExtensionState(host.pi);
  state.sessionActive = true;
  state.lifecycleGeneration = 1;
  state.currentNamesFile = path.join(f.root, "names.json");
  registerAsyncDeliveryEvents(state);
  return { f, host, state };
}

test("explicit stops record completion silently without waking the parent or entering model context", async () => {
  const { f, host, state } = setup();
  try {
    const entries: SessionEntry[] = [];
    const ctx = host.makeCtx(entries);
    const result = makeResult({
      name: "Isabel",
      startedAt: 100,
      exitCode: 130,
      stopReason: "aborted",
      errorMessage: "Subagent was aborted.",
      usage: { ...emptyUsage(), cost: 2 },
    });
    publishCompletion(state, result, 1, { jobId: "launch", taskIndex: 0 });
    // Stop may happen after result settlement but before its scheduled notification.
    persistWorkerStops(state.currentNamesFile, ["Isabel"], 200);
    await until(() => host.calls.sentMessages.length === 1);
    const { message, options } = host.calls.sentMessages[0];
    assert.equal(message.display, false);
    assert.deepEqual(options, { triggerTurn: false });
    assert.doesNotMatch(JSON.stringify(message.content), /failed|aborted/i);
    const stored = {
      role: "custom" as const,
      customType: message.customType,
      content: message.content,
      display: false,
      details: serializedDetails(message.details),
      timestamp: Date.now(),
    };
    entries.push(messageEntry(stored, "silent-completion"));
    await host.emit("message_start", { message: stored }, ctx);
    assert.equal(state.pendingCompletionDeliveries.size, 0, "silent settlement must not keep the parent waiting");
    const ordinary = fauxAssistantMessage("continue");
    const filtered = (await host.emit("context", { messages: [stored, ordinary] }, ctx)).at(-1) as {
      messages: unknown[];
    };
    assert.deepEqual(filtered.messages, [ordinary]);
    const accounting = getNestedSubagentResults([stored]);
    assert.equal(accounting[0].details.results[0].usage.cost, 2, "stopped worker usage remains recorded");
  } finally {
    state.sessionActive = false;
    f.close();
  }
});

test("unexpected failures, later resumes and successful completions are still reported", async () => {
  const { f, host, state } = setup();
  try {
    persistWorkerStops(state.currentNamesFile, ["Isabel"], 200);
    for (const result of [
      makeResult({ name: "Other", startedAt: 100, exitCode: 130, stopReason: "aborted", errorMessage: "unexpected" }),
      makeResult({ name: "Isabel", startedAt: 300, exitCode: 1, stopReason: "error", errorMessage: "new failure" }),
      makeResult({ name: "Isabel", startedAt: 100, exitCode: 0, stopReason: "stop", finalOutput: "finished" }),
    ])
      publishCompletion(state, result, 1);
    await until(() => host.calls.sentMessages.length === 3);
    for (const delivery of host.calls.sentMessages) {
      assert.equal(delivery.message.display, true);
      assert.equal(delivery.options?.triggerTurn, true);
    }
  } finally {
    state.sessionActive = false;
    f.close();
  }
});

test("a stopped broker job uses its submission time even if it never started", async () => {
  const { f, host, state } = setup();
  try {
    persistWorkerStops(state.currentNamesFile, ["Queued"], 200);
    const queued = makeResult({
      name: "Queued",
      submittedAt: 100,
      startedAt: 300,
      exitCode: 1,
      stopReason: "error",
      errorMessage: "Worker subtree stopped",
    });
    const wire = JSON.parse(JSON.stringify(compactSingleResultForDurableDetails(queued)));
    assert.equal(wire.submittedAt, 100);
    publishCompletion(state, wire, 1);
    await until(() => host.calls.sentMessages.length === 1);
    assert.equal(host.calls.sentMessages[0].message.display, false);
    assert.equal(host.calls.sentMessages[0].options?.triggerTurn, false);
  } finally {
    state.sessionActive = false;
    f.close();
  }
});
