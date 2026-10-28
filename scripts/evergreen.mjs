import { cpSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Fixtures beneath the checkout otherwise inherit ancestor .pi agents/settings.
const source = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "pi-subagent-evergreen-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PI[_-]SUBAGENT/.test(key)));
try {
  cpSync(source, workspace, {
    recursive: true,
    filter: (file) => file === source || ![".git", "node_modules", "tmp"].includes(basename(file)),
  });
  symlinkSync(join(source, "node_modules"), join(workspace, "node_modules"), "dir");
  for (const directory of ["test", "test/e2e"]) {
    const files = readdirSync(join(workspace, directory))
      .filter((file) => /\.test\.(?:ts|mjs)$/.test(file))
      .sort()
      .map((file) => join(directory, file));
    const result = spawnSync(process.execPath, ["--import", "tsx/esm", "--test", "--test-concurrency=1", ...files], {
      cwd: workspace,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
