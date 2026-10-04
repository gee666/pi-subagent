import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { configuredEnv, loadSubagentSettings, readSettings, SETTING_DEFINITIONS } from "../settings.js";
import { findProjectConfig, loadPiSubagentsConfig } from "../config.js";
import { configuredTotalBudget } from "../budget.js";
import { configuredNonNegativeInt } from "../runner/constants.js";
import { excludedExtensions, subagentDisabled } from "../runner/extension-policy.js";
import { getPiSpawnCommand } from "../runner/launch.js";
import { discoverAgents } from "../agents.js";
import { settingsFixture } from "./helpers/settings.js";

const presets = [{ tiny: { model: "tiny", provider: "local", "reasoning-level": "off" } }];

test("every user setting maps to its env counterpart with typed JSON and env priority", () => {
  const config: Record<string, Record<string, unknown>> = {};
  for (const [group, key, , type] of SETTING_DEFINITIONS) {
    (config[group] ??= {})[key] =
      type === "boolean"
        ? false
        : type === "integer"
          ? 0
          : type === "list"
            ? []
            : type === "confirmation"
              ? "session"
              : "some value";
  }
  const settings = readSettings(config, "test");
  assert.equal(Object.keys(settings).length, SETTING_DEFINITIONS.length);
  for (const [, , env, type] of SETTING_DEFINITIONS) {
    const encoded =
      type === "boolean"
        ? "false"
        : type === "integer"
          ? "0"
          : type === "list"
            ? "[]"
            : type === "confirmation"
              ? "session"
              : "some value";
    assert.equal(configuredEnv(env, settings, {}), encoded, env);
    assert.equal(configuredEnv(env, settings, { [env]: "env" }), "env", env);
    assert.equal(configuredEnv(env, settings, { [env]: "" }), "", env);
    assert.equal(configuredEnv(env, {}, {}), undefined, env);
  }
});

test("both permanent filenames support settings, retain singular collision priority and existing formats", () => {
  const f = settingsFixture();
  try {
    const homePi = path.join(f.home, ".pi");
    const projectPi = path.join(f.project, ".pi");
    f.write(
      homePi,
      { limits: { parallel: 7, concurrency: 2 }, "tool-prompts": { subagents: "home" } },
      "pi-subagents.json",
    );
    f.write(f.agent, { limits: { parallel: 9 }, models: { intelligence: false }, "subagents-models": presets });
    f.write(
      projectPi,
      { limits: { total: 4 }, models: { intelligence: true }, "tool-prompts": { subagents: "project" } },
      "pi-subagents.json",
    );
    const nested = path.join(f.project, "nested");
    fs.mkdirSync(nested);
    assert.equal(findProjectConfig(nested), path.join(projectPi, "pi-subagents.json"));
    assert.equal(loadPiSubagentsConfig(nested).toolPrompts.subagents, "home");
    assert.equal(loadSubagentSettings(nested).PI_SUBAGENT_MAX_TOTAL_AGENTS, undefined);
    const trusted = loadPiSubagentsConfig(nested, true);
    assert.equal(trusted.toolPrompts.subagents, "project");
    assert.equal(trusted.intelligencePresets[0].name, "tiny");
    assert.deepEqual(trusted.settings, {
      PI_SUBAGENT_MAX_PARALLEL_TASKS: "9",
      PI_SUBAGENT_MAX_CONCURRENCY: "2",
      PI_SUBAGENT_MAX_TOTAL_AGENTS: "4",
      PI_SUBAGENT_INTELLIGENCE: "true",
    });
    assert.deepEqual(loadPiSubagentsConfig(nested).intelligencePresets, []);
    process.env.PI_SUBAGENT_INTELLIGENCE = "false";
    assert.deepEqual(loadPiSubagentsConfig(nested, true).intelligencePresets, []);
    f.write(projectPi, { limits: { parallel: 1 } });
    assert.equal(findProjectConfig(nested), path.join(projectPi, "pi-subagent.json"));
    assert.equal(loadSubagentSettings(nested, true).PI_SUBAGENT_MAX_PARALLEL_TASKS, "1");
    assert.equal(loadSubagentSettings(nested, true).PI_SUBAGENT_MAX_TOTAL_AGENTS, undefined);
    f.write(path.join(nested, ".pi"), { limits: { total: 0 } }, "pi-subagents.json");
    assert.equal(loadSubagentSettings(nested, true).PI_SUBAGENT_MAX_TOTAL_AGENTS, "0");
  } finally {
    f.close();
  }
});

test("invalid JSON fields warn without contents, keep valid lower fields and fail closed on budgets", (t) => {
  const f = settingsFixture();
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  try {
    f.write(f.agent, { limits: { concurrency: 2 } });
    f.write(path.join(f.project, ".pi"), {
      runner: { argsPrefix: [42], command: "" },
      models: { fallback: { secret: "hidden-secret" } },
      limits: { concurrency: -1, total: "hidden-secret" },
      agents: [],
      resume: { prompt: "false" },
      delegation: { depth: Number.MAX_SAFE_INTEGER + 1 },
    });
    const settings = loadSubagentSettings(f.project, true);
    assert.equal(settings.PI_SUBAGENT_MAX_CONCURRENCY, "2");
    assert.equal(settings.PI_SUBAGENT_RESUME_PROMPT, undefined);
    assert.equal(settings.PI_SUBAGENT_PI_ARGS_PREFIX, undefined);
    assert.equal(settings.PI_SUBAGENT_MAX_DEPTH, undefined);
    assert.throws(() => configuredTotalBudget(configuredEnv("PI_SUBAGENT_MAX_TOTAL_AGENTS", settings)), /blocked/);
    assert.equal(warnings.length, 8);
    assert.doesNotMatch(JSON.stringify(warnings), /hidden-secret/);
    process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS = "0";
    assert.equal(configuredTotalBudget(configuredEnv("PI_SUBAGENT_MAX_TOTAL_AGENTS", settings)), 0);
    fs.writeFileSync(path.join(f.agent, "pi-subagent.json"), '{"secret":"hidden-secret"');
    assert.doesNotThrow(() => loadSubagentSettings());
    assert.doesNotMatch(JSON.stringify(warnings), /hidden-secret/);
  } finally {
    f.close();
  }
});

test("aliases preserve env union semantics and override JSON, including empty lists and false", () => {
  const settings = readSettings({ extension: { disabled: true, exclude: ["one", "two"] } }, "test");
  assert.equal(subagentDisabled({}, settings), true);
  assert.equal(subagentDisabled({ PI_SUBAGENT_DISABLED: "0" }, settings), false);
  assert.equal(subagentDisabled({ "PI-SUBAGENT-DISABLED": "false" }, settings), false);
  assert.equal(subagentDisabled({ PI_SUBAGENT_DISABLED: "0", "PI-SUBAGENT-DISABLED": "TRUE" }, settings), true);
  assert.deepEqual(excludedExtensions({}, settings), ["one", "two"]);
  assert.deepEqual(excludedExtensions({ PI_SUBAGENT_EXCLUDE_EXTENSIONS: "" }, settings), []);
  assert.deepEqual(
    excludedExtensions(
      { PI_SUBAGENT_EXCLUDE_EXTENSIONS: "one", "PI-SUBAGENT-EXCLUDE-EXTENSIONS": "two,one" },
      settings,
    ),
    ["two", "one"],
  );
});

test("JSON exclusion arrays preserve commas while env exclusions retain CSV semantics and priority", () => {
  const settings = readSettings(
    { extension: { exclude: ["./dir,one/hook.ts", "other", "./dir,one/hook.ts", " ./literal, path.ts "] } },
    "test",
  );
  assert.deepEqual(excludedExtensions({}, settings), ["./dir,one/hook.ts", "other", " ./literal, path.ts "]);
  assert.deepEqual(excludedExtensions({ PI_SUBAGENT_EXCLUDE_EXTENSIONS: "one,two" }, settings), ["one", "two"]);
  assert.deepEqual(excludedExtensions({ "PI-SUBAGENT-EXCLUDE-EXTENSIONS": "" }, settings), []);
});

test("settings are read at use time, not import time, and do not mutate env or configuration", () => {
  const f = settingsFixture();
  try {
    const value = {
      runner: { startupTimeoutMs: 0, startupRetries: 4, command: "test-command", argsPrefix: ["a b", "--"] },
    };
    f.write(f.agent, value, "pi-subagents.json");
    const source = fs.readFileSync(path.join(f.agent, "pi-subagents.json"), "utf8");
    assert.equal(configuredNonNegativeInt("PI_SUBAGENT_STARTUP_TIMEOUT", 120000), 0);
    assert.equal(configuredNonNegativeInt("PI_SUBAGENT_STARTUP_RETRIES", 2), 4);
    assert.deepEqual(getPiSpawnCommand(), { command: "test-command", argsPrefix: ["a b", "--"] });
    assert.equal(
      discoverAgents(f.project, "both").agents.some((a) => a.source === "builtin"),
      false,
    );
    assert.equal(process.env.PI_SUBAGENT_PI_COMMAND, undefined);
    assert.equal(fs.readFileSync(path.join(f.agent, "pi-subagents.json"), "utf8"), source);
    f.write(f.agent, { runner: { startupRetries: 0 } }, "pi-subagents.json");
    assert.equal(configuredNonNegativeInt("PI_SUBAGENT_STARTUP_RETRIES", 2), 0);
  } finally {
    f.close();
  }
});

test("the production extension env inventory contains only mapped settings, aliases and runtime metadata", () => {
  const found = new Set<string>();
  const scan = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && ![".git", "node_modules", "test", "tmp"].includes(entry.name)) scan(file);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(/["']((?:PI[_-]SUBAGENT[_-][A-Z_-]+|DISABLE_RESUMABLE_SUBAGENTS))["']/g))
          found.add(match[1]);
      }
    }
  };
  scan(process.cwd());
  const expected = new Set<string>([
    ...SETTING_DEFINITIONS.map(([, , env]) => env),
    "PI-SUBAGENT-DISABLED",
    "PI-SUBAGENT-EXCLUDE-EXTENSIONS",
    "PI_SUBAGENT_DEPTH",
    "PI_SUBAGENT_STACK",
    "PI_SUBAGENT_NAMES_FILE",
    "PI_SUBAGENT_SESSION_ROOT",
    "PI_SUBAGENT_BUDGET_DIR",
    "PI_SUBAGENT_RUN_INTELLIGENCE",
  ]);
  assert.deepEqual([...found].sort(), [...expected].sort());
});

test("runtime identity and ledger paths cannot be supplied through JSON", () => {
  const raw = {
    PI_SUBAGENT_DEPTH: 0,
    PI_SUBAGENT_STACK: [],
    PI_SUBAGENT_NAMES_FILE: "/other",
    PI_SUBAGENT_SESSION_ROOT: "/other",
    PI_SUBAGENT_BUDGET_DIR: "/other",
    PI_SUBAGENT_RUN_INTELLIGENCE: "fake",
    delegation: { currentDepth: 0, stack: [] },
    limits: { budgetDir: "/other" },
  };
  assert.deepEqual(readSettings(raw, "test"), {});
});
