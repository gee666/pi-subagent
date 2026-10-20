import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { killProcessTreeImmediately } from "../runner/launch.js";
import { settingsFixture } from "./helpers/settings.js";
import { until } from "./helpers/message-subagent.js";

function alive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0] !== "Z";
  } catch {
    return false;
  }
}

// Let the target run while this test process is paused at a specific kill boundary.
function waitSynchronously(check: () => boolean, timeoutMs = 250) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
}

test(
  "stop freezes a detached subtree before a live parent can replace a killed child",
  {
    skip: process.platform !== "linux",
    timeout: 10000,
  },
  async (t) => {
    const f = settingsFixture();
    const childFile = path.join(f.root, "child");
    const replacementFile = path.join(f.root, "replacement");
    const childScript = (file: string) =>
      `require('node:fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const rootScript = `
    const {spawn} = require('node:child_process');
    const child = script => spawn(process.execPath, ['-e', script], {detached:true, stdio:'ignore'}).unref();
    process.on('SIGUSR2', () => child(${JSON.stringify(childScript(replacementFile))}));
    child(${JSON.stringify(childScript(childFile))});
    setInterval(() => {}, 1000);
  `;
    const root = spawn(process.execPath, ["-e", rootScript], { detached: true, stdio: "ignore" });
    const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const rootClosed = once(root, "close");
    const siblingClosed = once(sibling, "close");
    const kill = process.kill.bind(process);
    let child = 0;
    let replacement = 0;
    let intercepted = false;
    try {
      await until(() => fs.existsSync(childFile));
      child = Number(fs.readFileSync(childFile, "utf8"));
      assert.ok(root.pid && sibling.pid);
      t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === "SIGKILL" && Math.abs(pid) === child && !intercepted) {
          intercepted = true;
          // Simulate the stopper being descheduled after its snapshot. A running parent
          // can fork here; a frozen parent cannot execute the pending signal handler.
          kill(root.pid!, "SIGUSR2");
          waitSynchronously(() => fs.existsSync(replacementFile));
        }
        return kill(pid, signal);
      });
      killProcessTreeImmediately(root);
      t.mock.restoreAll();
      await rootClosed;
      assert.equal(intercepted, true);
      await until(() => !alive(child));
      if (fs.existsSync(replacementFile)) replacement = Number(fs.readFileSync(replacementFile, "utf8"));
      assert.equal(
        Boolean(replacement && alive(replacement)),
        false,
        "a detached replacement must not escape the stopped subtree",
      );
      assert.equal(alive(sibling.pid), true, "a sibling process group must remain untouched");
    } finally {
      t.mock.restoreAll();
      killProcessTreeImmediately(root);
      killProcessTreeImmediately(sibling);
      if (fs.existsSync(replacementFile)) replacement = Number(fs.readFileSync(replacementFile, "utf8"));
      for (const pid of [child, replacement]) {
        if (!pid) continue;
        try {
          kill(-pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
      await Promise.all([rootClosed, siblingClosed]);
      f.close();
    }
  },
);
