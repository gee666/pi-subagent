import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SETTING_DEFINITIONS } from "../../settings.js";

function resolved(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function isWithin(dir: string, parent: string): boolean {
  const relative = path.relative(resolved(parent), resolved(dir));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function settingsFixture() {
  // Config discovery walks cwd ancestors, so a root under the real home would pick
  // up (and save-settings would overwrite) the user's ~/.pi config.
  const base = os.tmpdir();
  // The account home, not $HOME, which an unclosed fixture may have replaced.
  if (isWithin(base, os.userInfo().homedir))
    throw new Error(`Settings fixtures need a TMPDIR outside your home directory; got ${base}.`);
  const root = fs.mkdtempSync(path.join(base, "pi-subagent-settings-"));
  const home = path.join(root, "home");
  const agent = path.join(root, "agent");
  const project = path.join(root, "project");
  for (const dir of [home, agent, project]) fs.mkdirSync(dir);
  // Child scripts written under the root resolve packages by walking up from their own path.
  // Recursive rm unlinks this link without following it.
  const packages = path.resolve("node_modules");
  if (fs.existsSync(packages)) fs.symlinkSync(packages, path.join(root, "node_modules"), "junction");
  const keys = new Set([
    ...SETTING_DEFINITIONS.map(([, , env]) => env),
    // Legacy-switch regression tests must not leak these envs into later tests.
    "DISABLE_RESUMABLE_SUBAGENTS",
    "PI_SUBAGENT_RESUME_PROMPT",
    "PI-SUBAGENT-DISABLED",
    "PI-SUBAGENT-EXCLUDE-EXTENSIONS",
    "PI_SUBAGENT_DEPTH",
    "PI_SUBAGENT_STACK",
    "PI_SUBAGENT_BUDGET_DIR",
    "PI_SUBAGENT_NAMES_FILE",
    "PI_SUBAGENT_SESSION_ROOT",
    "PI_SUBAGENT_RUN_INTELLIGENCE",
    "PI_SUBAGENT_CONCURRENCY_DIR",
    "PI_SUBAGENT_WORKER_TOKEN",
    "PI_SUBAGENT_BROKER_DIR",
    "PI_SUBAGENT_BROKER_SECRET",
    "HOME",
    "USERPROFILE",
    "PI_CODING_AGENT_DIR",
    "TMPDIR",
  ]);
  const previous = Object.fromEntries([...keys].map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, TMPDIR: root });
  return {
    root,
    home,
    agent,
    project,
    write(dir: string, value: unknown, name = "pi-subagent.json") {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    },
    close() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
