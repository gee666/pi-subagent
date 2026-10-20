import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runAttempt } from "../runner/attempt.js";
import type { RunningSubagentHandle } from "../runner/options.js";
import { buildSubagentDetails } from "../types.js";
import { makeRunningResult } from "./helpers/results.js";
import { settingsFixture } from "./helpers/settings.js";
import { until } from "./helpers/message-subagent.js";

test(
  "running handles kill with SIGKILL immediately, retain usage and reject steering",
  { timeout: 15000 },
  async () => {
    const f = settingsFixture();
    const ready = path.join(f.root, "ready");
    const term = path.join(f.root, "term");
    const controller = new AbortController();
    let handle: RunningSubagentHandle | undefined;
    const result = makeRunningResult({
      usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, cost: 0.5, turns: 1, contextTokens: 18 },
    });
    const usage = { ...result.usage };
    const script = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(term)}, 'graceful'));
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    setInterval(() => {}, 1000);
  `;
    const run = runAttempt(
      {
        cwd: f.root,
        agents: [],
        agentName: "worker",
        task: "work",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: false,
        piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
        startupTimeoutMsOverride: 0,
        idleTimeoutMsOverride: 0,
        terminationTimeoutMsOverride: 10000,
        signal: controller.signal,
        onHandle: (value) => {
          handle = value;
        },
        makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
      },
      result,
      [],
      "work",
      0,
      () => {},
    );
    try {
      await until(() => fs.existsSync(ready));
      assert.ok(handle?.kill);
      const started = Date.now();
      handle.kill();
      controller.abort();
      assert.equal(await handle.steer("must not resurrect"), false);
      const outcome = await run;
      assert.ok(Date.now() - started < 1500, "must not wait for the ten-second graceful termination timeout");
      assert.equal(outcome.wasAborted, true);
      assert.equal(outcome.exitCode, 130);
      assert.equal(outcome.startupTimedOut, false);
      assert.equal(fs.existsSync(term), false, "stop must not send SIGTERM before SIGKILL");
      assert.deepEqual(result.usage, usage);
      handle.kill();
    } finally {
      controller.abort();
      await run;
      f.close();
    }
  },
);
