import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { runAttempt } from "../runner/attempt.js";
import type { AttemptState } from "../runner/attempt-state.js";
import type { RunAgentOptions, RunningSubagentHandle } from "../runner/options.js";
import { createProtocolHandler, createSteeringHandle } from "../runner/protocol.js";
import { makeRunningResult } from "./helpers/results.js";

function protocol(t: TestContext, timeoutMs = 1000, writeSucceeds = true) {
  const state: AttemptState = {
    resolved: false,
    receivedFirstEvent: true,
    agentSettled: false,
    startupTimedOut: false,
    wasAborted: false,
    activeToolCallIds: new Set(),
  };
  const result = makeRunningResult();
  const sent: Record<string, unknown>[] = [];
  let stopped = 0;
  const line = createProtocolHandler({
    state,
    result,
    promptRequestId: "initial",
    emitUpdate() {},
    noteSemanticActivity() {},
    stopChild() {},
    doResolve() {},
    forceStopAndSettle() {
      stopped++;
    },
  });
  const event = (value: Record<string, unknown>) => line(JSON.stringify(value));
  const handle = createSteeringHandle({
    state,
    result,
    promptRequestId: "initial",
    timeoutMs,
    noteSemanticActivity() {},
    settleDeferred: () => event({ type: "agent_settled" }),
    sendRpc(command) {
      sent.push(command);
      return writeSucceeds;
    },
  });
  t.after(() => {
    state.stopping = true;
    for (const complete of state.pendingSteeringRequests!.values()) complete(false);
  });
  const response = (id: unknown, success: boolean, command = "prompt") =>
    event({ type: "response", id, command, success, error: "Cannot submit a prompt while compaction is in progress." });
  return { state, result, sent, event, handle, response, stopped: () => stopped };
}

test("steering waits for its matching prompt response, including out-of-order rejections", async (t) => {
  const p = protocol(t);
  const first = p.handle.steer("first");
  const second = p.handle.steer("second");
  let answered = false;
  void Promise.resolve(first).then(() => {
    answered = true;
  });
  p.response("initial", true);
  p.response("unknown", true);
  p.response(p.sent[0].id, true, "steer");
  await Promise.resolve();
  assert.equal(answered, false, "writing or unrelated responses must not report acceptance");
  assert.equal(p.state.pendingSteeringRequests!.size, 2);
  assert.notEqual(p.sent[0].id, p.sent[1].id);
  assert.deepEqual(
    p.sent.map(({ type, streamingBehavior }) => [type, streamingBehavior]),
    [
      ["prompt", "steer"],
      ["prompt", "steer"],
    ],
  );
  p.response(p.sent[1].id, false);
  assert.equal(await second, false);
  assert.match(p.result.stderr, /Steering prompt rejected:.*compaction/);
  assert.equal(p.result.errorMessage, undefined, "reject delivery without failing the current model run");
  p.response(p.sent[0].id, true);
  assert.equal(await first, true);
  p.response(p.sent[0].id, false);
  assert.equal(p.state.pendingSteeringRequests!.size, 0);
  assert.equal(p.stopped(), 0);
});

test("settlement cannot reap pending steering, and a late acceptance waits for the new turn", async (t) => {
  const p = protocol(t);
  const accepted = p.handle.steer("continue");
  p.event({ type: "agent_settled" });
  assert.equal(p.stopped(), 0);
  assert.equal(p.state.agentSettled, false);
  p.response(p.sent[0].id, true);
  assert.equal(await accepted, true);
  assert.equal(p.stopped(), 0, "an old settlement must not kill the accepted continuation");
  p.event({ type: "turn_start" });
  p.event({ type: "agent_settled" });
  assert.equal(p.stopped(), 1);
  assert.equal(await p.handle.steer("too late"), false);
  assert.equal(p.sent.length, 1);
});

test("only the last rejected request releases a deferred settlement", async (t) => {
  const p = protocol(t);
  const first = p.handle.steer("first");
  const second = p.handle.steer("second");
  p.event({ type: "agent_settled" });
  p.response(p.sent[0].id, false);
  assert.equal(await first, false);
  assert.equal(p.stopped(), 0);
  p.response(p.sent[1].id, false);
  assert.equal(await second, false);
  assert.equal(p.stopped(), 1);
});

test("steering rejection preserves background-child keepalive", async (t) => {
  const p = protocol(t);
  const pending = p.handle.steer("retry later");
  p.event({ type: "subagent_background", running: 2 });
  p.event({ type: "agent_settled" });
  p.response(p.sent[0].id, false);
  assert.equal(await pending, false);
  assert.equal(p.state.backgroundJobs, 2);
  assert.equal(p.state.waitingForChildren, true);
  assert.equal(p.stopped(), 0);
  p.event({ type: "subagent_background", running: 0 });
  p.event({ type: "turn_start" });
  p.event({ type: "agent_settled" });
  assert.equal(p.stopped(), 1);
});

test("unanswered steering times out false and releases its pending settlement", async (t) => {
  const p = protocol(t, 20);
  const accepted = p.handle.steer("lost response");
  p.event({ type: "agent_settled" });
  assert.equal(await accepted, false);
  assert.equal(p.state.pendingSteeringRequests!.size, 0);
  assert.equal(p.stopped(), 1);
  assert.match(p.result.stderr, /Steering acknowledgment timed out/);
  p.response(p.sent[0].id, true);
  assert.equal(p.stopped(), 1, "late responses cannot complete a timed-out request twice");
});

function child(
  t: TestContext,
  steeringCode: string,
  overrides: Partial<RunAgentOptions> = {},
  emitUpdate: () => void = () => {},
) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const result = makeRunningResult();
  let handle!: RunningSubagentHandle;
  const code = `
    const send = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const command = JSON.parse(line);
      if (!command.id?.includes("-steer-")) {
        send({ type: "response", command: "prompt", id: command.id, success: true });
        send({ type: "turn_start" });
      } else { ${steeringCode} }
    });
  `;
  const done = runAttempt(
    {
      cwd: process.cwd(),
      agents: [],
      agentName: "test-agent",
      task: "test",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: false,
      settings: {},
      signal: controller.signal,
      startupTimeoutMsOverride: 5000,
      idleTimeoutMsOverride: 5000,
      terminationTimeoutMsOverride: 100,
      steeringTimeoutMsOverride: 1000,
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", code, "--"] },
      makeDetails() {
        throw new Error("unexpected details request");
      },
      ...overrides,
      onHandle(value) {
        handle = value;
      },
    },
    result,
    [],
    "initial task",
    0,
    emitUpdate,
  );
  return { result, handle, done, abort: () => controller.abort() };
}

test(
  "real RPC child survives an old settlement until steering acceptance and continuation",
  { timeout: 10000 },
  async (t) => {
    const c = child(
      t,
      `
    send({ type: "agent_settled" });
    setTimeout(() => {
      send({ type: "response", command: "prompt", id: command.id, success: true });
      send({ type: "turn_start" });
      setTimeout(() => {
        send({ type: "message_end", message: {
          role: "assistant", content: [{ type: "text", text: "continued" }], stopReason: "stop"
        } });
        send({ type: "agent_settled" });
      }, 30);
    }, 30);
  `,
    );
    assert.equal(await c.handle.steer("continue"), true);
    assert.equal((await c.done).exitCode, 0);
    assert.equal(c.result.messages.length, 1);
  },
);

test("real RPC compaction rejection returns false instead of write success", { timeout: 10000 }, async (t) => {
  const c = child(
    t,
    `
    send({ type: "agent_settled" });
    send({ type: "response", command: "prompt", id: command.id, success: false, error: "compaction in progress" });
  `,
  );
  assert.equal(await c.handle.steer("continue"), false);
  assert.equal((await c.done).exitCode, 0);
  assert.match(c.result.stderr, /compaction in progress/);
});

test("abort settles all outstanding steering and rejects subsequent delivery", { timeout: 10000 }, async (t) => {
  const c = child(t, "");
  const first = c.handle.steer("one");
  const second = c.handle.steer("two");
  c.abort();
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(await c.handle.steer("after abort"), false);
  assert.equal((await c.done).wasAborted, true);
});

test(
  "child exit and spawn errors settle steering false without waiting for its timeout",
  { timeout: 10000 },
  async (t) => {
    const exiting = child(t, "process.exit(3);", { steeringTimeoutMsOverride: 60_000 });
    assert.equal(await exiting.handle.steer("exit"), false);
    assert.equal((await exiting.done).exitCode, 3);
    const missing = child(t, "", {
      piCommandOverride: { command: "/nonexistent/pi-subagent-steering-test" },
      steeringTimeoutMsOverride: 60_000,
    });
    assert.equal(await missing.handle.steer("spawn failure"), false);
    assert.equal((await missing.done).exitCode, 1);
  },
);

test("stdin failure settles every pending steering request", { timeout: 10000 }, async (t) => {
  let ready!: () => void;
  const closedStdin = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let updates = 0;
  const c = child(
    t,
    `
    process.stdin.destroy();
    require("node:fs").closeSync(0);
    setInterval(() => {}, 1000);
    setTimeout(() => send({ type: "turn_start" }), 20);
  `,
    { steeringTimeoutMsOverride: 60_000 },
    () => {
      if (++updates === 2) ready();
    },
  );
  const first = c.handle.steer("close stdin");
  await closedStdin;
  const second = c.handle.steer("broken pipe");
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal((await c.done).exitCode, 1);
  assert.match(c.result.errorMessage!, /RPC stdin failed/);
  assert.equal(await c.handle.steer("after error"), false);
});

test("initial prompt rejection also fails outstanding steering", { timeout: 10000 }, async (t) => {
  const c = child(t, "", {
    piCommandOverride: {
      command: process.execPath,
      argsPrefix: [
        "-e",
        `
        require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
          const command = JSON.parse(line);
          if (!command.id?.includes("-steer-")) console.log(JSON.stringify({
            type: "response", command: "prompt", id: command.id, success: false, error: "no model"
          }));
        });
      `,
        "--",
      ],
    },
    steeringTimeoutMsOverride: 60_000,
  });
  assert.equal(await c.handle.steer("still pending"), false);
  assert.equal((await c.done).exitCode, 1);
  assert.match(c.result.errorMessage!, /Subagent prompt rejected: no model/);
});

test("a failed stdin write resolves false and leaves no pending request", async (t) => {
  const p = protocol(t, 60_000, false);
  assert.equal(await p.handle.steer("cannot write"), false);
  assert.equal(p.state.pendingSteeringRequests!.size, 0);
  assert.equal(p.stopped(), 0);
  p.state.stopping = true;
  assert.equal(await p.handle.steer("stopping"), false);
  assert.equal(p.sent.length, 1);
});

test("legacy void and boolean steering mocks remain assignable", async () => {
  const handles: RunningSubagentHandle[] = [{ steer() {} }, { steer: () => false }, { steer: async () => true }];
  assert.deepEqual(await Promise.all(handles.map((handle) => handle.steer("test"))), [undefined, false, true]);
});
