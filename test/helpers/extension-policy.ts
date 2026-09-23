import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-exclusions-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const marker = path.join(root, "loaded.jsonl");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  function write(file: string, content: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }
  function extension(file: string, name: string) {
    return write(
      file,
      `import { appendFileSync } from "node:fs";
      appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)});
      export default function(pi) { pi.registerCommand(${JSON.stringify(name)}, { description: "fixture", handler: async () => {} }); }
    `,
    );
  }
  function pkg(dir: string, name: string, command: string) {
    write(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.2.3", pi: { extensions: ["index.ts"] } }));
    extension(path.join(dir, "index.ts"), command);
    return dir;
  }
  return {
    root,
    cwd,
    agentDir,
    marker,
    write,
    extension,
    pkg,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function rpc(f: ReturnType<typeof fixture>, args: string[], expectProvider = false) {
  const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--mode", "rpc", "--no-session", "--offline", ...args], {
    cwd: f.cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    input: '{"id":"commands","type":"get_commands"}\n{"id":"models","type":"get_available_models"}\n',
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"command":"get_commands"/);
  if (expectProvider) assert.match(result.stdout, /fixture-auth-model/);
  return fs.existsSync(f.marker) ? fs.readFileSync(f.marker, "utf8").trim().split("\n") : [];
}
