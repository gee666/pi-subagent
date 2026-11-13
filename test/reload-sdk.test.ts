import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import subagentExtension from "../index.js";
import { SUBAGENT_COMPLETION_TYPE } from "../types.js";
import { settingsFixture } from "./helpers/settings.js";

async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await delay(20);
  }
}

test("a real Pi reload keeps a running worker and delivers its completion to the reloaded session", async () => {
  const f = settingsFixture();
  const file = (name: string) => path.join(f.root, name);
  const script = file("worker.cjs");
  fs.writeFileSync(
    script,
    `const fs = require("node:fs");
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      if (JSON.parse(line).type !== "prompt") return;
      fs.writeFileSync(${JSON.stringify(file("pid"))}, String(process.pid));
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(file("release"))})) return;
        clearInterval(timer);
        console.log(JSON.stringify({ type: "message_end", message: { role: "assistant",
          content: [{ type: "text", text: "survived" }], stopReason: "stop" } }));
        console.log(JSON.stringify({ type: "agent_settled" }));
      }, 10);
    });`,
  );
  f.write(f.agent, { runner: { command: process.execPath, argsPrefix: [script] }, limits: { total: 2 } });
  // The nearest project config wins over presets in any ancestor of this checkout.
  f.write(path.join(f.project, ".pi"), { "subagents-models": [] });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerProvider("reload-fixture", {
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
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const launch = last?.role === "user";
      const message = {
        ...(launch
          ? fauxAssistantMessage(
              {
                type: "toolCall",
                id: "launch-call",
                name: "subagents",
                arguments: { tasks: [{ task: "work", max_subagents_allowed: 0 }] },
              },
              { stopReason: "toolUse" },
            )
          : fauxAssistantMessage("ok")),
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: launch ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: f.project,
    agentDir: f.agent,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [subagentExtension],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: f.project,
    agentDir: f.agent,
    modelRuntime: runtime,
    model: runtime.getModel("reload-fixture", "fixture"),
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(f.project),
  });
  const errors: string[] = [];
  const completions = () =>
    session.messages.filter((message) => message.role === "custom" && message.customType === SUBAGENT_COMPLETION_TYPE);
  try {
    await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error.error) });
    await session.prompt("Launch a worker");
    await until(() => fs.existsSync(file("pid")), "worker never started");
    const pid = Number(fs.readFileSync(file("pid"), "utf8"));
    await session.reload();
    process.kill(pid, 0); // Still running: a dead pid throws.
    fs.writeFileSync(file("release"), "go");
    await until(() => completions().length === 1, "completion did not reach the reloaded session");
    assert.match(JSON.stringify(completions()[0]), /survived/);
    await until(() => session.getLastAssistantText() === "ok" && session.isIdle, "completion did not wake the lead");
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    f.close();
  }
});
