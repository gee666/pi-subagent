import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifyLead } from "../extension/async-jobs.js";
import { createExtensionState } from "../extension/state.js";
import { parseTranscriptMessages } from "../detail.js";
import { SUBAGENT_MESSAGE_TYPE } from "../types.js";
import { hostDouble } from "./helpers/extension.js";

function fixture() {
  const sent: Array<{
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: Parameters<ExtensionAPI["sendMessage"]>[1];
  }> = [];
  const state = createExtensionState(
    hostDouble<ExtensionAPI>({
      getFlag: () => undefined,
      sendMessage: (message, options) => {
        sent.push({ message, options });
      },
      sendUserMessage: () => {
        assert.fail("Subagent notifications must not masquerade as human messages");
      },
    }),
  );
  state.sessionActive = true;
  return { state, sent };
}

test("subagent steering uses Pi's custom-message box and still wakes idle leads", () => {
  const { state, sent } = fixture();
  const content = "Message from subagent Alice:\nIdle, waiting for children.\nImplementation ready.";
  notifyLead(state, content);
  assert.deepEqual(sent, [
    {
      message: { customType: SUBAGENT_MESSAGE_TYPE, content, display: true, details: undefined },
      options: { deliverAs: "steer", triggerTurn: true },
    },
  ]);
});

test("old-generation and inactive notifications remain suppressed", () => {
  const { state, sent } = fixture();
  notifyLead(state, "stale", state.lifecycleGeneration - 1);
  state.sessionActive = false;
  notifyLead(state, "inactive");
  assert.deepEqual(sent, []);
});

test("custom subagent messages remain visible in the saved activity timeline without creating another task", () => {
  const parsed = parseTranscriptMessages([
    { type: "message", message: { role: "user", content: "Original assignment" } },
    {
      type: "message",
      message: {
        role: "custom",
        customType: SUBAGENT_MESSAGE_TYPE,
        content: "Message from subagent Alice:\nTests passed.",
        timestamp: 1000,
      },
    },
  ]);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].prompt, "Original assignment");
  assert.deepEqual(parsed.blocks[0].events, [
    {
      type: "message",
      label: "SUBAGENT",
      text: "Message from subagent Alice:\nTests passed.",
      at: 1000,
    },
  ]);
});
