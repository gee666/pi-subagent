import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import {
  BROADCAST_STEER_PREFIX,
  decodeNestedBroadcast,
  encodeNestedBroadcast,
  forwardNestedBroadcast,
  parseBroadcastSelection,
  sendBroadcastToTargets,
  updateLatestBroadcastTargets,
} from "../extension/broadcast.js";
import { registerSessionEvents } from "../extension/events.js";
import { createExtensionState } from "../extension/state.js";
import { buildLiveSubagentDetails } from "../types.js";
import { hostDouble } from "./helpers/extension.js";
import { makeRunningResult } from "./helpers/results.js";

type InputHandler = (
  event: InputEvent,
  ctx: ExtensionContext,
) => InputEventResult | void | Promise<InputEventResult | void>;

function fixture() {
  let input: InputHandler | undefined;
  const state = createExtensionState(
    hostDouble<ExtensionAPI>({
      getFlag: () => undefined,
      on: ((name: string, handler: InputHandler) => {
        if (name === "input") input = handler;
      }) as ExtensionAPI["on"],
    }),
  );
  state.currentDepth = 0;
  const sent: Array<{ id: number; message: string }> = [];
  const notices: Array<{ message: string; type: string | undefined }> = [];
  const ctx = hostDouble<ExtensionContext>({
    hasUI: true,
    mode: "tui",
    ui: hostDouble<ExtensionContext["ui"]>({
      notify: (message, type) => {
        notices.push({ message, type });
      },
    }),
  });
  const add = (id: number, name: string) => {
    state.activeSubagents.set(id, {
      agent: "worker",
      task: "work",
      name,
      handle: {
        steer: (message) => {
          sent.push({ id, message });
        },
      },
    });
  };
  add(1, "John");
  add(2, "Ada");
  registerSessionEvents(state);
  assert.ok(input);
  return {
    state,
    ctx,
    sent,
    notices,
    add,
    input: (text: string, options: Partial<InputEvent> = {}) =>
      input!({ type: "input", source: "rpc", text, ...options }, ctx),
  };
}

const details = (name: string, child?: string) =>
  buildLiveSubagentDetails("single", "spawn", null, [
    makeRunningResult({
      name,
      ...(child
        ? {
            liveNestedSubagents: {
              children: buildLiveSubagentDetails("single", "spawn", null, [makeRunningResult({ name: child })]),
            },
          }
        : {}),
    }),
  ]);

for (const source of ["interactive", "rpc", "extension"] as const) {
  for (const streamingBehavior of [undefined, "steer", "followUp"] as const) {
    test(`${source} ${streamingBehavior ?? "idle"} input never prompts or auto-broadcasts`, async () => {
      const f = fixture();
      // select/input/isIdle are absent from the strict context double.
      assert.deepEqual(await f.input("normal lead message", { source, streamingBehavior }), { action: "continue" });
      assert.deepEqual(f.sent, []);
      assert.deepEqual(f.notices, []);
    });
  }
}

test("child-to-lead steering reaches a lead that itself has running children", async () => {
  const f = fixture();
  f.state.currentDepth = 1;
  assert.deepEqual(
    await f.input("Message from subagent Maria:\nfindings", {
      source: "extension",
      streamingBehavior: "steer",
    }),
    { action: "continue" },
  );
  assert.deepEqual(f.sent, []);
});

test("nested routing forwards exactly one named path without UI", async () => {
  const f = fixture();
  f.ctx.hasUI = false;
  f.ctx.mode = "print";
  const text = encodeNestedBroadcast("targeted message", ["jOhN", "Maria"]);
  assert.deepEqual(await f.input(text), { action: "handled" });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, 1);
  assert.deepEqual(decodeNestedBroadcast(f.sent[0].message), { path: ["Maria"], message: "targeted message" });
});

test("final routed hop is plain steering and never fans out to its own children", async () => {
  const parent = fixture();
  const leaf = fixture();
  parent.state.activeSubagents.get(1)!.name = "Maria";
  assert.deepEqual(await parent.input(encodeNestedBroadcast("message", ["Maria"])), { action: "handled" });
  assert.deepEqual(parent.sent, [{ id: 1, message: "message" }]);
  assert.deepEqual(await leaf.input(parent.sent[0].message, { streamingBehavior: "steer" }), { action: "continue" });
  assert.deepEqual(leaf.sent, []);
});

test("stale and empty routing paths are consumed without becoming lead input", async () => {
  const f = fixture();
  for (const path of [["Missing"], []]) {
    assert.deepEqual(await f.input(encodeNestedBroadcast("message", path)), { action: "handled" });
  }
  f.state.activeSubagents.clear();
  assert.deepEqual(await f.input(encodeNestedBroadcast("message", ["John"])), { action: "handled" });
  assert.deepEqual(f.sent, []);
});

test("forwarding helper does not handle ordinary text or malformed envelopes", async () => {
  const f = fixture();
  for (const text of ["hello", `${BROADCAST_STEER_PREFIX}{`, `${BROADCAST_STEER_PREFIX}{"path":[1],"message":"x"}`]) {
    assert.equal(await forwardNestedBroadcast(f.state, text, f.ctx), false);
  }
  assert.deepEqual(f.sent, []);
});

test("a delivery or notification failure never leaks an envelope into the lead conversation", async () => {
  const f = fixture();
  f.state.activeSubagents.get(1)!.handle.steer = async () => {
    throw new Error("delivery failed");
  };
  assert.deepEqual(await f.input(encodeNestedBroadcast("message", ["John"])), { action: "handled" });
  assert.ok(f.notices.some(({ type, message }) => type === "warning" && /could not accept/.test(message)));
  f.ctx.ui.notify = () => {
    throw new Error("UI failed");
  };
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args);
  };
  try {
    assert.deepEqual(await f.input(encodeNestedBroadcast("message", ["John"])), { action: "handled" });
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
});

test("independent async snapshots and handle changes preserve other roots' nested targets", () => {
  const f = fixture();
  updateLatestBroadcastTargets(f.state, details("John", "Maria"), 1);
  updateLatestBroadcastTargets(f.state, details("Ada", "Cy"), 2);
  assert.deepEqual(
    f.state.latestBroadcastTargets.all.map(({ display }) => display),
    ["Ada", "Ada > Cy", "John", "John > Maria"],
  );
  assert.deepEqual(
    f.state.latestBroadcastTargets.youngest.map(({ display }) => display),
    ["Ada > Cy", "John > Maria"],
  );
  f.add(3, "New");
  updateLatestBroadcastTargets(f.state, undefined);
  assert.equal(f.state.latestBroadcastTargets.all.length, 5);
  updateLatestBroadcastTargets(f.state, details("John"), 1);
  assert.deepEqual(
    f.state.latestBroadcastTargets.youngest.map(({ display }) => display),
    ["Ada > Cy", "John", "New"],
  );
  f.state.activeSubagents.delete(1);
  updateLatestBroadcastTargets(f.state, undefined);
  assert.deepEqual(
    f.state.latestBroadcastTargets.all.map(({ display }) => display),
    ["Ada", "Ada > Cy", "New"],
  );
});

test("selection parses names and full nested paths without accepting numeric IDs", () => {
  const available = [
    { display: "John", topLevelId: 1, restPath: [] },
    { display: "John > Maria", topLevelId: 1, restPath: ["Maria"] },
  ];
  assert.deepEqual(parseBroadcastSelection("john > maria, MARIA, John, 1", available), {
    targets: [available[1], available[0]],
    errors: ['Subagent "1" is not running. Use its human name.'],
  });
});

test("delivery waits for acknowledgments, sends concurrently, and isolates rejected targets", async () => {
  const f = fixture();
  let acknowledge!: (accepted: boolean) => void;
  f.state.activeSubagents.get(1)!.handle.steer = () =>
    new Promise<boolean>((resolve) => {
      acknowledge = resolve;
    });
  f.state.activeSubagents.get(2)!.handle.steer = async () => {
    throw new Error("closed");
  };
  f.add(3, "Settling");
  f.state.activeSubagents.get(3)!.handle.steer = () => false;
  const promise = sendBroadcastToTargets(
    f.state,
    "message",
    [
      { display: "John", topLevelId: 1, restPath: [] },
      { display: "Ada", topLevelId: 2, restPath: [] },
      { display: "Settling", topLevelId: 3, restPath: [] },
      { display: "Missing", topLevelId: 4, restPath: [] },
    ],
    f.ctx,
  );
  assert.equal(f.notices.length, 0);
  acknowledge(true);
  await promise;
  assert.ok(f.notices.some(({ message, type }) => type === "info" && message.endsWith("John")));
  assert.ok(f.notices.some(({ message }) => /no longer running: Missing/.test(message)));
  assert.ok(
    f.notices.some(
      ({ message }) => /could not accept/.test(message) && message.includes("Ada") && message.includes("Settling"),
    ),
  );
});

test("late delivery acknowledgments do not notify a replacement session", async () => {
  const f = fixture();
  f.state.activeSubagents.get(1)!.handle.steer = async () => {
    f.state.lifecycleGeneration++;
    return true;
  };
  await sendBroadcastToTargets(f.state, "message", [{ display: "John", topLevelId: 1, restPath: [] }], f.ctx);
  assert.deepEqual(f.notices, []);
});
