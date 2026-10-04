import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadPiSubagentsConfig } from "../config.js";
import { loadSubagentSettings } from "../settings.js";
import { getPiSpawnCommand } from "../runner/launch.js";
import { createExtensionHarness } from "./helpers/extension.js";
import { settingsFixture } from "./helpers/settings.js";

test("runner command and argsPrefix are personal-only even when config-only SDK projects are automatically trusted", async (t) => {
  const f = settingsFixture();
  const warnings: string[] = [];
  t.mock.method(console, "warn", (value: string) => warnings.push(value));
  try {
    const marker = path.join(f.root, "project-executed");
    const safe = `process.stdin.once("data", () => {
      console.log(JSON.stringify({type:"message_end",message:{
        role:"assistant",content:[{type:"text",text:"personal command"}],stopReason:"stop"
      }}));
      console.log(JSON.stringify({type:"agent_settled"}));
    });`;
    const hostile = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "project command");`;
    f.write(f.agent, {
      runner: { command: process.execPath, argsPrefix: ["-e", safe, "--"] },
      limits: { total: 1 },
      resume: { disabled: true, disableAuto: true },
    });
    for (const filename of ["pi-subagent.json", "pi-subagents.json"]) {
      const projectPi = path.join(f.project, ".pi");
      f.write(
        projectPi,
        {
          runner: { command: "PROJECT_EXECUTABLE", argsPrefix: ["-e", hostile, "--"], idleTimeoutMs: 1234 },
        },
        filename,
      );
      const sdkSettings = SettingsManager.create(f.project, f.agent);
      assert.equal(sdkSettings.isProjectTrusted(), true, "SDK trust is true without an explicit decision");
      for (const settings of [loadSubagentSettings(f.project, true), loadPiSubagentsConfig(f.project, true).settings]) {
        assert.equal(settings.PI_SUBAGENT_PI_COMMAND, process.execPath);
        assert.equal(settings.PI_SUBAGENT_PI_ARGS_PREFIX, JSON.stringify(["-e", safe, "--"]));
        assert.equal(settings.PI_SUBAGENT_IDLE_TIMEOUT, "1234", "non-executable project settings still merge");
        assert.deepEqual(getPiSpawnCommand(undefined, settings), {
          command: process.execPath,
          argsPrefix: ["-e", safe, "--"],
        });
      }
      const host = createExtensionHarness();
      const ctx = host.makeCtx([], {
        cwd: f.project,
        hasUI: false,
        isProjectTrusted: () => sdkSettings.isProjectTrusted(),
      });
      await host.emit("session_start", {}, ctx);
      const result = await host.call(
        "subagents",
        "personal-command",
        {
          tasks: [{ task: "work", max_subagents_allowed: 0 }],
        },
        ctx,
      );
      assert.equal(result.isError, false, JSON.stringify(result.content));
      assert.match(JSON.stringify(result.content), /personal command/);
      assert.equal(fs.existsSync(marker), false);
      await host.emit("session_shutdown", {}, ctx);
      fs.rmSync(path.join(projectPi, filename));
    }
    assert.ok(warnings.some((value) => value.includes("runner.command") && value.includes("personal-only")));
    assert.ok(warnings.some((value) => value.includes("runner.argsPrefix") && value.includes("personal-only")));
    assert.equal(
      warnings.some((value) => value.includes(hostile)),
      false,
    );
    fs.rmSync(path.join(f.agent, "pi-subagent.json"));
    f.write(path.join(f.project, ".pi"), { runner: { command: "PROJECT_EXECUTABLE", argsPrefix: ["hostile"] } });
    assert.equal(loadSubagentSettings(f.project, true).PI_SUBAGENT_PI_COMMAND, undefined);
    assert.equal(loadPiSubagentsConfig(f.project, true).settings.PI_SUBAGENT_PI_ARGS_PREFIX, undefined);
    process.env.PI_SUBAGENT_PI_COMMAND = "environment-command";
    process.env.PI_SUBAGENT_PI_ARGS_PREFIX = '["environment-argument"]';
    assert.deepEqual(getPiSpawnCommand(undefined, loadSubagentSettings(f.project, true)), {
      command: "environment-command",
      argsPrefix: ["environment-argument"],
    });
  } finally {
    f.close();
  }
});

test("fresh SDK launches without an explicit trust grant override stale --approve and do not reload project resources", () => {
  const f = settingsFixture();
  try {
    const marker = path.join(f.root, "extension-executed");
    const projectPi = path.join(f.project, ".pi");
    fs.mkdirSync(path.join(projectPi, "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(projectPi, "extensions", "project.ts"),
      `import * as fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "loaded"); export default () => {};`,
    );
    fs.writeFileSync(path.join(projectPi, "settings.json"), JSON.stringify({ shellPath: "PROJECT_SHELL" }));
    f.write(projectPi, { models: { fallback: "project/should-not-load" } });
    const child = path.join(f.root, "child.mjs");
    fs.writeFileSync(
      child,
      `
      import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
      const { parseArgs } = await import(new URL("./cli/args.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
      const approval = parseArgs(process.argv.slice(2)).projectTrustOverride;
      const settings = SettingsManager.create(process.cwd(), process.env.PI_CODING_AGENT_DIR, { projectTrusted: approval });
      const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings });
      await loader.reload();
      process.stdin.once("data", () => {
        const value = { args: process.argv.slice(2), approval, project: settings.getProjectSettings() };
        console.log(JSON.stringify({type:"message_end",message:{role:"assistant",
          content:[{type:"text",text:JSON.stringify(value)}],stopReason:"stop"}}));
        console.log(JSON.stringify({type:"agent_settled"}));
      });
    `,
    );
    const driver = `
      process.argv = [process.execPath, "parent", "--approve"];
      const { runAgentSubprocess } = await import(${JSON.stringify(pathToFileURL(path.resolve("runner.ts")).href)});
      const { buildSubagentDetails, getFinalOutput } = await import(${JSON.stringify(pathToFileURL(path.resolve("types.ts")).href)});
      const fs = await import("node:fs");
      const results = [];
      for (const trust of [undefined, false, true]) {
        fs.rmSync(${JSON.stringify(marker)}, { force: true });
        const result = await runAgentSubprocess({
          cwd: ${JSON.stringify(f.project)}, ...(trust === undefined ? {} : { projectTrusted: trust }),
          agents: [{ name: "worker", description: "", source: "user", filePath: "", systemPrompt: "" }],
          agentName: "worker", task: "work", parentDepth: 0, parentAgentStack: [], maxDepth: 1, preventCycles: true,
          makeDetails: results => buildSubagentDetails("single", "spawn", null, results),
          piCommandOverride: { command: process.execPath, argsPrefix: [${JSON.stringify(child)}] },
          startupTimeoutMsOverride: 10000,
        });
        if (result.exitCode !== 0) throw new Error(result.errorMessage);
        results.push({ ...JSON.parse(getFinalOutput(result.messages)), executed: fs.existsSync(${JSON.stringify(marker)}) });
      }
      console.log(JSON.stringify(results));
    `;
    const results = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", driver], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, JITI_CACHE_DIR: path.join(f.root, "jiti"), PI_OFFLINE: "1" },
      }),
    );
    assert.equal(results.length, 3);
    for (const result of results.slice(0, 2)) {
      assert.ok(result.args.includes("--no-approve"));
      assert.equal(result.approval, false);
      assert.equal(result.executed, false);
      assert.deepEqual(result.project, {});
    }
    assert.equal(results[2].approval, true);
    assert.equal(results[2].executed, true, "explicit trust is the positive control");
    assert.equal(results[2].project.shellPath, "PROJECT_SHELL");
  } finally {
    f.close();
  }
});
