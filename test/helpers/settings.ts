import * as fs from "node:fs";
import * as path from "node:path";
import { SETTING_DEFINITIONS } from "../../settings.js";

export function settingsFixture() {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/settings-"));
  const home = path.join(root, "home");
  const agent = path.join(root, "agent");
  const project = path.join(root, "project");
  for (const dir of [home, agent, project]) fs.mkdirSync(dir);
  const keys = new Set([
    ...SETTING_DEFINITIONS.map(([, , env]) => env),
    "PI-SUBAGENT-DISABLED",
    "PI-SUBAGENT-EXCLUDE-EXTENSIONS",
    "PI_SUBAGENT_DEPTH",
    "PI_SUBAGENT_STACK",
    "PI_SUBAGENT_BUDGET_DIR",
    "PI_SUBAGENT_NAMES_FILE",
    "PI_SUBAGENT_SESSION_ROOT",
    "PI_SUBAGENT_RUN_INTELLIGENCE",
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
