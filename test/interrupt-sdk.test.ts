import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { registerSubagentInterrupt } from "../extension/interrupt.js";
import { createExtensionState, type ExtensionState } from "../extension/state.js";
import { SUBAGENT_COMPLETION_TYPE } from "../types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("real SDK completion wake without a pending resume and run-scoped main-only interrupts", async () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/interrupt-sdk-"));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  let waiting = false;
  let started = deferred();
  runtime.registerProvider("interrupt-fixture", {
    api: "openai-completions",
    baseUrl: "https://fixture.invalid",
    apiKey: "dummy-key",
    models: [
      {
        id: "fixture",
        name: "fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 128,
      },
    ],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("completion handled"),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (waiting) {
          options?.signal?.addEventListener(
            "abort",
            () => {
              stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } });
              stream.end();
            },
            { once: true },
          );
          started.resolve();
        } else {
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        }
      });
      return stream;
    },
  });
  let state: ExtensionState | undefined;
  let context: ExtensionContext | undefined;
  const kinds: string[] = [];
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: path.join(root, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        state = createExtensionState(pi);
        state.currentDepth = 0;
        state.sessionActive = true;
        registerSubagentInterrupt(state);
        pi.on("before_agent_start", (event) => {
          kinds.push(event.messageType);
        });
        pi.on("agent_start", (_event, ctx) => {
          context = ctx;
        });
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: path.join(root, "agent"),
    modelRuntime: runtime,
    model: runtime.getModel("interrupt-fixture", "fixture"),
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(root),
    tools: [],
  });
  const errors: string[] = [];
  try {
    await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
    assert.ok(state);
    assert.equal(state.pendingAutomaticResume, undefined);
    await session.sendCustomMessage(
      {
        customType: SUBAGENT_COMPLETION_TYPE,
        content: "Subagent finished: done",
        display: true,
        details: undefined,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    assert.deepEqual(kinds, ["custom"]);
    assert.equal(session.getLastAssistantText(), "completion handled");
    assert.deepEqual(errors, [], "completion wake must not dereference an absent pending resume");

    let kills = 0;
    state.activeSubagents.set(1, {
      agent: "",
      task: "work",
      handle: {
        steer() {},
        kill() {
          kills++;
        },
      },
    });
    waiting = true;
    const first = session.prompt("Wait for interruption");
    await started.promise;
    assert.ok(context);
    const shortcut = session.extensionRunner.getShortcuts({ "app.interrupt": "escape" }).get("alt+w");
    assert.ok(shortcut, "main-only shortcut must not conflict with Pi's reserved interrupt");
    await shortcut.handler(context);
    await first;
    assert.equal(kills, 0, "the shortcut's aborted settlement must preserve subagents");

    started = deferred();
    const second = session.prompt("Wait for a normal interruption");
    await started.promise;
    await session.abort();
    await second;
    assert.equal(kills, 1, "a later normal abort must not inherit the previous run's exception");
    assert.deepEqual(errors, []);
  } finally {
    session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
