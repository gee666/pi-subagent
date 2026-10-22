import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { findLatestResumableSubagentCalls } from "../resume.js";
import { sessionEntryMessage } from "../storage/session-entries.js";
import { buildSubagentDetails, SUBAGENT_COMPLETION_TYPE, type SingleResult } from "../types.js";
import { assistantSubagentCall, makeResult, subagentToolResult, tasks } from "./fixtures/resume.js";

function worker(index: number, overrides: Partial<SingleResult> = {}): SingleResult {
  return makeResult({
    ...tasks[index],
    name: index === 0 ? "Ada" : "Bo",
    sessionDir: `/workers/${index}`,
    startedAt: 100 + index,
    exitCode: -1,
    stopReason: undefined,
    errorMessage: undefined,
    stderr: "",
    ...overrides,
  });
}

/** Persist the way Pi really does: launches as `message`, completions as `custom_message` entries. */
function persistedSession(completed: number[]): ExtensionContext {
  const sm = SessionManager.inMemory();
  for (const entry of [
    assistantSubagentCall("launch"),
    subagentToolResult(
      "launch",
      Object.assign(buildSubagentDetails("parallel", "spawn", null, [worker(0), worker(1)]), {
        asyncJobId: "launch",
      }),
      false,
    ),
  ] as Array<Extract<SessionEntry, { type: "message" }>>)
    sm.appendMessage(entry.message as Parameters<SessionManager["appendMessage"]>[0]);
  for (const index of completed) {
    const details = Object.assign(
      buildSubagentDetails("single", "spawn", null, [worker(index, { exitCode: 0, stopReason: "stop" })]),
      { asyncJobId: "launch", asyncTaskIndex: index },
    );
    sm.appendCustomMessageEntry(SUBAGENT_COMPLETION_TYPE, "finished", true, JSON.parse(JSON.stringify(details)));
  }
  sm.appendMessage({ role: "user", content: "Keep going.", timestamp: Date.now() });
  return { sessionManager: sm, hasUI: false, cwd: process.cwd() } as unknown as ExtensionContext;
}

test("async completions persisted as custom_message entries close their launch slots", () => {
  assert.deepEqual(findLatestResumableSubagentCalls(persistedSession([0, 1])), []);
});

test("only the async slot without a custom_message completion remains resumable", () => {
  const plans = findLatestResumableSubagentCalls(persistedSession([1]));
  assert.equal(plans.length, 1);
  assert.deepEqual(
    plans[0].details?.results.map((result) => result.exitCode),
    [-1, 0],
  );
});

test("sessionEntryMessage converts custom_message entries like Pi's context builder", () => {
  const sm = SessionManager.inMemory();
  sm.appendCustomMessageEntry(SUBAGENT_COMPLETION_TYPE, "done", true, { brokerJobId: "job" });
  const message = sessionEntryMessage(sm.getEntries().at(-1));
  assert.equal(message?.role, "custom");
  assert.equal(message?.customType, SUBAGENT_COMPLETION_TYPE);
  assert.deepEqual(message?.details, { brokerJobId: "job" });
  assert.equal(sessionEntryMessage({ type: "custom", customType: "x" }), undefined);
});
