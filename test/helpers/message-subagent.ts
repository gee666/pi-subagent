import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createBudget, reserveSubagentBudgets } from "../../budget.js";
import { allocateSubagentNames } from "../../names.js";
import { loadSubagentSettings } from "../../settings.js";
import { registerMessageSubagentTool } from "../../extension/message-tool.js";
import { createExtensionState } from "../../extension/state.js";
import type { RunningSubagentHandle } from "../../runner/options.js";
import { registerSubagentsTool } from "../../extension/launch-tool.js";
import { shutdownScheduler } from "../../extension/scheduler.js";
import { settingsFixture } from "./settings.js";

export async function fixture() {
  const f = settingsFixture();
  let registered: ToolDefinition | undefined;
  const pi = {
    getFlag: () => undefined,
    registerTool: (tool: ToolDefinition) => {
      registered = tool;
    },
    sendMessage: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  const state = createExtensionState(pi);
  state.canDelegate = true;
  state.sessionActive = true;
  state.currentOwnerId = "owner";
  state.currentNamesFile = path.join(f.root, "names.json");
  state.currentSubagentSessionRoot = path.join(f.root, "sessions");
  state.currentBudget = createBudget(path.join(f.root, "budget"), 12);
  const [budget] = reserveSubagentBudgets(state.currentBudget, "original", [
    { agent: "removed-worker", task: "original task", max_subagents_allowed: 2 },
  ]);
  const sessionDir = path.join(f.root, "saved");
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, "session.jsonl"), JSON.stringify({ type: "session", id: "original" }) + "\n");
  const [name] = await allocateSubagentNames(state.currentNamesFile, state.currentOwnerId, [
    {
      agent: "removed-worker",
      task: "original task",
      sessionDir,
      budget,
      model: "original/provider-model",
      thinking: "high",
      intelligence: "old-label",
      tools: ["read"],
    },
  ]);
  const ctx = { cwd: f.project, hasUI: false, isProjectTrusted: () => true } as ExtensionContext;
  state.latestSessionCtx = ctx;
  registerMessageSubagentTool(state);
  assert.ok(registered);
  const tool = registered;
  return {
    ...f,
    state,
    tool,
    budget,
    name,
    sessionDir,
    ctx,
    running(steer: RunningSubagentHandle["steer"], isSettling?: () => boolean) {
      state.activeSubagents.set(1, { name, agent: "removed-worker", task: "old", handle: { steer, isSettling } });
    },
    launch(params: Record<string, unknown>, id = "siblings") {
      registerSubagentsTool(state);
      assert.ok(registered);
      return registered.execute(id, params, undefined, undefined, ctx);
    },
    execute: (params: unknown, signal?: AbortSignal, onUpdate?: () => void) =>
      tool.execute(`message-${Math.random()}`, params as Record<string, unknown>, signal, onUpdate, ctx),
    async close() {
      for (const job of state.backgroundJobs.values()) job.controller.abort();
      await Promise.allSettled(Array.from(state.backgroundJobs.values(), (job) => job.promise));
      for (const timer of state.scheduledTasks) clearTimeout(timer);
      shutdownScheduler(state);
      f.close();
    },
  };
}

export function gatedRunner(f: Awaited<ReturnType<typeof fixture>>, separateGates = false) {
  const log = path.join(f.root, "runs.jsonl");
  const script = path.join(f.root, "fake-pi.cjs");
  fs.writeFileSync(
    script,
    `
    const fs = require("node:fs"), path = require("node:path");
    const args = process.argv.slice(2), flag = key => args[args.indexOf(key) + 1];
    const dir = args.includes("--session-dir") ? flag("--session-dir") : path.dirname(flag("--session"));
    fs.mkdirSync(dir, { recursive: true });
    const session = path.join(dir, "session.jsonl");
    if (!fs.existsSync(session)) fs.writeFileSync(session, JSON.stringify({ type: "session", id: "worker" }) + "\\n");
    require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      if (request.type !== "prompt") return;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, prompt: request.message,
        intelligence: JSON.parse(process.env.PI_SUBAGENT_RUN_INTELLIGENCE), budget: process.env.PI_SUBAGENT_BUDGET_DIR }) + "\\n");
      const gate = path.join(${JSON.stringify(f.root)}, ${separateGates} ? request.message.split("\\n")[0] : "release");
      const timer = setInterval(() => {
        if (!fs.existsSync(gate)) return;
        clearInterval(timer);
        console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished" }], stopReason: "stop" } }));
        console.log(JSON.stringify({ type: "agent_settled" }));
      }, 10);
    });
  `,
  );
  f.write(f.agent, { runner: { command: process.execPath, argsPrefix: [script] } });
  f.state.settings = loadSubagentSettings(f.project, true);
  return {
    log,
    release: (task = "release") => fs.writeFileSync(path.join(f.root, task), "done"),
    runs: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .split("\n")
            .slice(0, -1) // A concurrently appended final line may still be incomplete.
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  args: string[];
                  prompt: string;
                  intelligence: string | null;
                  budget: string;
                },
            )
        : [],
  };
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for background execution");
}

export function sdk(tool: ToolDefinition, args: Parameters<typeof validateToolArguments>[1]["arguments"]) {
  return validateToolArguments(tool, { type: "toolCall", id: "sdk-null", name: tool.name, arguments: args });
}

export function assertSuccess(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  assert.notEqual("isError" in result && result.isError, true, JSON.stringify(result.content));
}

export function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}
