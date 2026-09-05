import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildChildProcessEnv, getCurrentRuntimeLaunch, runAgentSubprocess } from "../runner.js";
import { buildSubagentDetails, type SingleResult } from "../types.js";
import type { AgentConfig } from "../agents.js";

const makeDetails = (results: SingleResult[]) => buildSubagentDetails("single", "spawn", null, results);

const fakeAgent: AgentConfig = {
  name: "test-agent",
  description: "test",
  systemPrompt: "hello",
  source: "user",
  filePath: "/fake",
};

const baseOpts: Omit<Parameters<typeof runAgentSubprocess>[0], "agents" | "agentName"> = {
  cwd: process.cwd(),
  task: "test",
  parentDepth: 0,
  parentAgentStack: [],
  maxDepth: 3,
  preventCycles: false,
  makeDetails,
};

describe("child process environment", () => {
  test("reuses the current runtime entrypoint without knowing Pi's install layout", () => {
    const tmpDir = path.join(process.cwd(), "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const dir = fs.mkdtempSync(path.join(tmpDir, "pi-entrypoint-test-"));
    try {
      const entrypoint = path.join(dir, "anything", "future-layout", "start.ts");
      fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
      fs.writeFileSync(entrypoint, "// test entrypoint");
      assert.deepEqual(getCurrentRuntimeLaunch(["bun", entrypoint], "C:\\runtime\\bun.exe"), {
        command: "C:\\runtime\\bun.exe",
        argsPrefix: [entrypoint],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves env values and repairs executable search paths", () => {
    const pnpmHome = path.join(process.cwd(), "fake-pnpm-home");
    const env = buildChildProcessEnv({ PNPM_HOME: pnpmHome, PI_TEST_SENTINEL: "kept" });
    const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");
    assert.equal(pathKeys.length, 1);
    const entries = String(env[pathKeys[0]]).split(path.delimiter);
    const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
    assert.ok(entries.map(normalize).includes(normalize(path.dirname(process.execPath))));
    assert.ok(entries.map(normalize).includes(normalize(pnpmHome)));
    assert.equal(env.PI_TEST_SENTINEL, "kept");
  });
});

describe("runAgentSubprocess — unknown agent", () => {
  test("returns exitCode 1 and agentSource unknown", async () => {
    const result = await runAgentSubprocess({
      ...baseOpts,
      agents: [],
      agentName: "nonexistent",
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.agentSource, "unknown");
    assert.ok(result.stderr.includes("nonexistent"), `Expected stderr to include 'nonexistent', got: ${result.stderr}`);
  });

  test("error message includes 'Available agents'", async () => {
    const result = await runAgentSubprocess({
      ...baseOpts,
      agents: [],
      agentName: "nonexistent",
    });

    assert.ok(
      result.stderr.includes("Available agents"),
      `Expected stderr to include 'Available agents', got: ${result.stderr}`,
    );
  });

  test("error message includes names of all available agents", async () => {
    const alpha: AgentConfig = { ...fakeAgent, name: "alpha" };
    const beta: AgentConfig = { ...fakeAgent, name: "beta" };

    const result = await runAgentSubprocess({
      ...baseOpts,
      agents: [alpha, beta],
      agentName: "gamma",
    });

    assert.ok(result.stderr.includes("alpha"), `Expected stderr to include 'alpha', got: ${result.stderr}`);
    assert.ok(result.stderr.includes("beta"), `Expected stderr to include 'beta', got: ${result.stderr}`);
  });
});
