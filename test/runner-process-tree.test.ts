import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { killProcessTreeImmediately } from "../runner/launch.js";
import { descendantPids } from "../runner/process-tree.js";
import { settingsFixture } from "./helpers/settings.js";
import { until } from "./helpers/message-subagent.js";

function alive(pid: number) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[0] !== "Z";
  } catch {
    return false;
  }
}

test(
  "explicit kill reaches detached descendants without killing a sibling process group",
  {
    timeout: 10000,
    skip: process.platform !== "linux",
  },
  async () => {
    const f = settingsFixture();
    const childFile = path.join(f.root, "child-pid");
    const grandchildFile = path.join(f.root, "grandchild-pid");
    const grandchildScript = `require('node:fs').writeFileSync(${JSON.stringify(grandchildFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const childScript = `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { detached: true, stdio: 'ignore' }).unref();
    require('node:fs').writeFileSync(${JSON.stringify(childFile)}, String(process.pid));
    setInterval(() => {}, 1000);
  `;
    const rootScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);`;
    const root = spawn(process.execPath, ["-e", rootScript], { detached: true, stdio: "ignore" });
    const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const rootClosed = once(root, "close");
    const siblingClosed = once(sibling, "close");
    let child = 0;
    let grandchild = 0;
    try {
      await until(() => fs.existsSync(childFile) && fs.existsSync(grandchildFile));
      child = Number(fs.readFileSync(childFile, "utf8"));
      grandchild = Number(fs.readFileSync(grandchildFile, "utf8"));
      assert.ok(root.pid && sibling.pid);
      const descendants = descendantPids(root.pid);
      assert.ok(descendants.includes(child));
      assert.ok(descendants.includes(grandchild));
      assert.ok(descendants.indexOf(grandchild) < descendants.indexOf(child), "kill leaves before their parents");
      killProcessTreeImmediately(root);
      await rootClosed;
      await until(() => !alive(child) && !alive(grandchild));
      assert.equal(alive(sibling.pid), true);
    } finally {
      killProcessTreeImmediately(root);
      killProcessTreeImmediately(sibling);
      for (const pid of [child, grandchild]) {
        if (!pid) continue;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await Promise.all([rootClosed, siblingClosed]);
      f.close();
    }
  },
);
