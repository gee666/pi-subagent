import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repo = fileURLToPath(new URL("../../", import.meta.url));
export const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PI[_-]/.test(key)));

export function run(command, args, { capture = "stdout", ...options } = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env: cleanEnv,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return capture === "both" ? result.stdout + result.stderr : result.stdout;
}

export function npm(args, options = {}) {
  // npm_execpath is set by npm test and also avoids .cmd execution on Windows.
  return process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], options)
    : run(process.platform === "win32" ? "npm.cmd" : "npm", args, { ...options, shell: process.platform === "win32" });
}

export function packedFixture() {
  mkdirSync(path.join(repo, "tmp"), { recursive: true });
  const root = mkdtempSync(path.join(repo, "tmp/startup-package-"));
  try {
    const [packed] = JSON.parse(npm(["pack", "--json", "--pack-destination", root]));
    run("tar", ["-xf", path.join(root, packed.filename), "-C", root]);
    const packageRoot = path.join(root, "package");
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const env = {
      ...cleanEnv,
      HOME: root,
      USERPROFILE: root,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
      JITI_CACHE_DIR: path.join(root, "jiti"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    };
    mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
    return {
      root,
      packageRoot,
      manifest,
      files: packed.files,
      env,
      close: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
