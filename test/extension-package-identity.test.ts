import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { childExtensionArgs } from "../runner/extension-policy.js";
import { fixture, rpc } from "./helpers/extension-policy.js";

const excludedName = "oira666_pi-free-swarm";

async function checkAutomatic(f: ReturnType<typeof fixture>, excluded: string[], kept: string[]) {
  const manager = new DefaultPackageManager({
    cwd: f.cwd,
    agentDir: f.agentDir,
    settingsManager: SettingsManager.create(f.cwd, f.agentDir, { projectTrusted: true }),
  });
  const resources = (await manager.resolve(async () => "error")).extensions;
  assert.ok(resources.length > 0);
  assert.ok(resources.every((resource) => resource.metadata.origin === "top-level"));
  assert.deepEqual(new Set(rpc(f, ["--approve"])), new Set([...excluded, ...kept]));
  fs.unlinkSync(f.marker);
  const args = await childExtensionArgs([], f.cwd, true, [excludedName], f.agentDir);
  assert.equal(fs.existsSync(f.marker), false, "identity discovery must not execute extensions");
  assert.deepEqual(new Set(rpc(f, args)), new Set(kept));
}

test("package names exclude automatic user and project extension directories", async () => {
  const f = fixture();
  try {
    f.pkg(path.join(f.agentDir, "extensions/user-swarm"), excludedName, "excluded-user");
    const project = f.pkg(path.join(f.cwd, ".pi/extensions/project-swarm"), excludedName, "unused");
    f.write(
      path.join(project, "package.json"),
      JSON.stringify({ name: excludedName, pi: { extensions: ["src/main.ts"] } }),
    );
    f.extension(path.join(project, "src/main.ts"), "excluded-project");
    f.pkg(path.join(f.agentDir, "extensions/auth"), "retained-auth", "retained-user");
    f.extension(path.join(f.cwd, ".pi/extensions/kept.ts"), "retained-project");
    await checkAutomatic(f, ["excluded-user", "excluded-project"], ["retained-user", "retained-project"]);
  } finally {
    f.cleanup();
  }
});

test("settings-listed files and directories use their nearest package manifest", async () => {
  const f = fixture();
  try {
    const user = f.pkg(path.join(f.root, "user-package"), excludedName, "unused");
    const userEntry = f.extension(path.join(user, "src/main.ts"), "excluded-user-setting");
    const project = f.pkg(path.join(f.cwd, "packages/project-package"), excludedName, "excluded-project-setting");
    f.write(path.join(f.agentDir, "settings.json"), JSON.stringify({ extensions: [userEntry] }));
    f.write(path.join(f.cwd, ".pi/settings.json"), JSON.stringify({ extensions: [project] }));
    f.extension(path.join(f.agentDir, "extensions/kept.ts"), "kept");
    await checkAutomatic(f, ["excluded-user-setting", "excluded-project-setting"], ["kept"]);
  } finally {
    f.cleanup();
  }
});

test("automatic directory and file symlinks use the target package identity", async () => {
  const f = fixture();
  try {
    const target = f.pkg(path.join(f.root, "linked-package"), excludedName, "excluded-directory-link");
    const nested = f.extension(path.join(target, "src/file.ts"), "excluded-file-link");
    const kept = f.pkg(path.join(f.root, "kept-package"), "kept-package", "kept-link");
    fs.mkdirSync(path.join(f.agentDir, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(f.cwd, ".pi/extensions"), { recursive: true });
    fs.symlinkSync(target, path.join(f.agentDir, "extensions/directory-link"), "dir");
    fs.symlinkSync(nested, path.join(f.cwd, ".pi/extensions/file-link.ts"), "file");
    fs.symlinkSync(kept, path.join(f.cwd, ".pi/extensions/kept-link"), "dir");
    await checkAutomatic(f, ["excluded-directory-link", "excluded-file-link"], ["kept-link"]);
  } finally {
    f.cleanup();
  }
});

test("loose hooks do not inherit workspace names and a nearer unnamed manifest stops ownership lookup", async () => {
  const f = fixture();
  try {
    for (const directory of [f.root, f.cwd, f.agentDir]) {
      f.write(path.join(directory, "package.json"), JSON.stringify({ name: excludedName }));
    }
    f.extension(path.join(f.agentDir, "extensions/loose.ts"), "loose-user");
    f.extension(path.join(f.cwd, ".pi/extensions/loose.ts"), "loose-project");
    const listed = f.extension(path.join(f.cwd, "scripts/hook.ts"), "loose-listed");
    f.write(path.join(f.cwd, ".pi/settings.json"), JSON.stringify({ extensions: [listed] }));
    for (const [folder, manifest] of [
      ["named", { name: "kept-package" }],
      ["unnamed", {}],
    ] as const) {
      const outer = path.join(f.agentDir, "extensions", folder);
      f.write(
        path.join(outer, "package.json"),
        JSON.stringify({ name: excludedName, pi: { extensions: ["inner/index.ts"] } }),
      );
      f.write(path.join(outer, "inner/package.json"), JSON.stringify(manifest));
      f.extension(path.join(outer, "inner/index.ts"), folder);
    }
    await checkAutomatic(f, [], ["loose-user", "loose-project", "loose-listed", "named", "unnamed"]);
  } finally {
    f.cleanup();
  }
});
