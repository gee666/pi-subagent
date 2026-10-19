import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { runAttempt } from "../runner/attempt.js";
import type { AttemptState } from "../runner/attempt-state.js";
import { createProtocolHandler } from "../runner/protocol.js";
import { buildSubagentDetails, getFinalOutput } from "../types.js";
import { makeRunningResult } from "./helpers/results.js";

const statusKey = "pi-subagent-background";

/** Only the session is fake: the installed RPC mode owns stdout, status serialization and event output. */
function rpcWorkerCode(): string {
  const rpcUrl = new URL("./modes/rpc/rpc-mode.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  return `
    const {runRpcMode} = await import(${JSON.stringify(rpcUrl.href)});
    const {startBackground, registerAsyncDeliveryEvents} = await import(${moduleUrl("../extension/async-jobs.ts")});
    const {publishCompletion} = await import(${moduleUrl("../extension/completion.ts")});
    const {createExtensionState} = await import(${moduleUrl("../extension/state.ts")});
    const {makeResult} = await import(${moduleUrl("./helpers/results.ts")});
    let emit, shutdown, consume;
    const text = value => ({role: "assistant", content: [{type: "text", text: value}], stopReason: "stop"});
    const state = createExtensionState({
      getFlag() {},
      on(name, handler) { if (name === "message_start") consume = handler; },
      sendMessage(message) {
        // Enqueueing is not consumption. Keep the reservation across another settlement.
        emit({type: "agent_settled"});
        setTimeout(() => {
          emit({type: "turn_start"});
          const custom = {...message, role: "custom", timestamp: Date.now()};
          consume({type: "message_start", message: custom});
          emit({type: "message_end", message: custom});
          emit({type: "message_end", message: text("Descendants settled; final answer.")});
          shutdown();
          emit({type: "agent_settled"});
        }, 100);
      },
    });
    state.currentDepth = 1;
    state.sessionActive = true;
    state.disabled = true; // Avoid unrelated footer/session lookups in this minimal host.
    registerAsyncDeliveryEvents(state);
    const session = {
      async bindExtensions(options) {
        state.latestSessionCtx = {mode: options.mode, ui: options.uiContext};
        shutdown = options.shutdownHandler;
      },
      subscribe(listener) { emit = listener; return () => {}; },
      agent: {subscribe() { return () => {}; }},
      async prompt(_message, options) {
        options.preflightResult(true);
        process.stdout.write("output-guard-probe\\n");
        emit({type: "turn_start"});
        startBackground(state, "child", ["Alice"], async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          publishCompletion(state, makeResult({name: "Alice"}), state.lifecycleGeneration);
          return {content: []};
        });
        emit({type: "message_end", message: text("My own answer is ready.")});
        emit({type: "agent_settled"});
        emit({type: "agent_settled"});
      },
    };
    await runRpcMode({session, setRebindSession() {}, async dispose() {}});
  `;
}

const childArgs = () => ["--import", "tsx/esm", "--input-type=module", "-e", rpcWorkerCode(), "--"];

test("real RPC status output stays ordered with settlement under the output guard", { timeout: 20000 }, async (t) => {
  const child = spawn(process.execPath, childArgs(), { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child.stdin.destroy();
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.write(`${JSON.stringify({ id: "initial", type: "prompt", message: "start" })}\n`);
  assert.equal(await closed, 0, stderr);
  assert.equal(stderr, "output-guard-probe\n", "ordinary stdout must be redirected, but no keepalive may leak there");
  const events = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const order = events.flatMap((event) => {
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === statusKey)
      return [`count:${event.statusText}`];
    return event.type === "agent_settled" || event.type === "turn_start" ? [event.type] : [];
  });
  assert.deepEqual(order, [
    "turn_start",
    "count:1",
    "agent_settled",
    "agent_settled",
    "count:2",
    "count:1",
    "agent_settled",
    "turn_start",
    "count:0",
    "agent_settled",
  ]);
  assert.ok(!events.some((event) => event.type === "subagent_background"));
  const messages = events.filter((event) => event.type === "message_end").map((event) => event.message);
  assert.ok(!JSON.stringify(messages).includes(statusKey), "keepalive transport must not add transcript metadata");
});

test(
  "runAttempt keeps the real RPC worker alive through queued completion and final settlement",
  { timeout: 20000 },
  async (t) => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const notifications: string[] = [];
    const snapshots: Array<{ idle: boolean; output: string }> = [];
    const result = makeRunningResult();
    const outcome = await runAttempt(
      {
        cwd: process.cwd(),
        agents: [],
        agentName: "lead",
        task: "wait for descendants",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: false,
        settings: {},
        signal: controller.signal,
        startupTimeoutMsOverride: 10000,
        idleTimeoutMsOverride: 1000,
        terminationTimeoutMsOverride: 500,
        piCommandOverride: { command: process.execPath, argsPrefix: childArgs() },
        makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
        onLeadMessage: (message) => {
          notifications.push(message);
        },
      },
      result,
      [],
      "start",
      0,
      () => snapshots.push({ idle: result.idle === true, output: getFinalOutput(result.messages) }),
    );
    assert.equal(outcome.exitCode, 0, result.stderr);
    assert.equal(outcome.startupTimedOut, false);
    assert.equal(outcome.wasAborted, false);
    assert.deepEqual(notifications, ["Idle, waiting for children.\nMy own answer is ready."]);
    assert.ok(snapshots.some((snapshot) => snapshot.idle && snapshot.output === "My own answer is ready."));
    assert.equal(result.idle, false);
    assert.equal(result.messages.filter((message) => message.role === "custom").length, 1);
    assert.equal(getFinalOutput(result.messages), "Descendants settled; final answer.");
    assert.equal(result.stderr, "output-guard-probe\n");
  },
);

test("the reserved RPC status accepts only nonnegative safe integer text without semantic activity", () => {
  const state: AttemptState = {
    resolved: false,
    receivedFirstEvent: true,
    agentSettled: false,
    startupTimedOut: false,
    wasAborted: false,
    activeToolCallIds: new Set(),
  };
  const result = makeRunningResult();
  const original = structuredClone(result);
  const unexpected = () => assert.fail("status transport must not emit progress, activity or settlement");
  const line = createProtocolHandler({
    state,
    result,
    promptRequestId: "initial",
    emitUpdate: unexpected,
    noteSemanticActivity: unexpected,
    stopChild: unexpected,
    doResolve: unexpected,
    forceStopAndSettle: unexpected,
  });
  const status = (statusText: unknown, overrides = {}) =>
    line(
      JSON.stringify({
        type: "extension_ui_request",
        method: "setStatus",
        statusKey,
        statusText,
        ...overrides,
      }),
    );
  status("3");
  assert.equal(state.backgroundJobs, 3);
  for (const invalid of [undefined, null, 0, "", " ", "-1", "+1", "1.5", "1e2", "Infinity", "NaN", "9007199254740992"])
    status(invalid);
  status("0", { statusKey: "another-extension" });
  status("0", { method: "notify" });
  status("0", { type: "other" });
  assert.equal(state.backgroundJobs, 3);
  status("0");
  assert.equal(state.backgroundJobs, 0);
  line(JSON.stringify({ type: "subagent_background", running: 2 }));
  assert.equal(state.backgroundJobs, 2, "retain the non-RPC/fixture transport");
  assert.deepEqual(result, original);
});
