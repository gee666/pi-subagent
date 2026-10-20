import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { loadSubagentSettings, readSettings, SETTING_DEFINITIONS, type SubagentSettings } from "../settings.js";
import { saveSubagentSettings } from "../storage/save-settings.js";
import { loadPiSubagentsConfig } from "../config.js";
import { settingsFixture } from "./helpers/settings.js";

function read(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

test("global save round-trips every definition as typed JSON without mutating input or env", () => {
  const f = settingsFixture();
  try {
    const config: Record<string, Record<string, unknown>> = {};
    for (const [group, key, , type] of SETTING_DEFINITIONS) {
      (config[group] ??= {})[key] =
        type === "boolean"
          ? false
          : type === "integer"
            ? 0
            : type === "list"
              ? ["one,two", "space path", ""]
              : type === "confirmation"
                ? "session"
                : "some value";
    }
    const settings = Object.freeze(readSettings(config, "fixture"));
    const env = { ...process.env };
    const file = saveSubagentSettings(f.project, "global", settings);
    assert.equal(file, path.join(f.agent, "pi-subagent.json"));
    assert.deepEqual(read(file), config);
    assert.deepEqual(loadSubagentSettings(), settings);
    assert.deepEqual({ ...process.env }, env);
    assert.equal(fs.existsSync(path.join(f.project, ".pi")), false);
    assert.equal(fs.existsSync(path.join(f.home, ".pi")), false);
  } finally {
    f.close();
  }
});

test("project save creates the singular filename and saves only supplied entries", () => {
  const f = settingsFixture();
  try {
    f.write(f.agent, { limits: { concurrency: 9 }, runner: { command: "personal" } });
    process.env.PI_SUBAGENT_MAX_TOTAL_AGENTS = "999";
    const settings = Object.freeze({ PI_SUBAGENT_DISABLED: "false", PI_SUBAGENT_EXCLUDE_EXTENSIONS: "[]" });
    const file = saveSubagentSettings(f.project, "project", settings);
    assert.equal(file, path.join(f.project, ".pi", "pi-subagent.json"));
    assert.deepEqual(read(file), { extension: { disabled: false, exclude: [] } });
    assert.deepEqual(read(path.join(f.agent, "pi-subagent.json")), {
      limits: { concurrency: 9 },
      runner: { command: "personal" },
    });
  } finally {
    f.close();
  }
});

test("project save uses the nearest config, honors both names and singular collision priority", () => {
  const f = settingsFixture();
  try {
    const nested = path.join(f.project, "nested");
    fs.mkdirSync(nested);
    const outer = path.join(f.project, ".pi");
    const inner = path.join(nested, ".pi");
    f.write(outer, { limits: { total: 7 } }, "pi-subagents.json");
    const plural = path.join(outer, "pi-subagents.json");
    assert.equal(saveSubagentSettings(nested, "project", { PI_SUBAGENT_MAX_DEPTH: "2" }), plural);
    assert.equal(fs.existsSync(path.join(outer, "pi-subagent.json")), false);
    assert.deepEqual(read(plural), { limits: { total: 7 }, delegation: { depth: 2 } });
    f.write(inner, { limits: { total: 3 } }, "pi-subagents.json");
    f.write(inner, { limits: { total: 4 } });
    assert.equal(
      saveSubagentSettings(nested, "project", { PI_SUBAGENT_MAX_TOTAL_AGENTS: "0" }),
      path.join(inner, "pi-subagent.json"),
    );
    assert.deepEqual(read(path.join(inner, "pi-subagents.json")), { limits: { total: 3 } });
    assert.deepEqual(read(path.join(inner, "pi-subagent.json")), { limits: { total: 0 } });
    assert.deepEqual(read(plural), { limits: { total: 7 }, delegation: { depth: 2 } });
  } finally {
    f.close();
  }
});

test("merging preserves unrelated top-level fields and sibling keys", () => {
  const f = settingsFixture();
  try {
    const original = {
      "tool-prompts": { subagents: "custom prompt" },
      "subagents-models": [{ small: { model: "test" } }],
      unknown: { nested: [1, false, null] },
      limits: { total: 8, concurrency: 3, custom: "keep" },
      agents: { confirmProject: "ask" },
    };
    f.write(f.agent, original);
    const file = saveSubagentSettings(f.project, "global", { PI_SUBAGENT_MAX_TOTAL_AGENTS: "2" });
    assert.deepEqual(read(file), { ...original, limits: { ...original.limits, total: 2 } });
    for (const value of ["true", "false", "ask", "never", "session"]) {
      saveSubagentSettings(f.project, "global", { PI_SUBAGENT_CONFIRM_PROJECT_AGENTS: value });
      assert.equal(loadSubagentSettings().PI_SUBAGENT_CONFIRM_PROJECT_AGENTS, value);
    }
  } finally {
    f.close();
  }
});

test("malformed JSON and non-object configs or updated groups throw without clobbering", () => {
  const f = settingsFixture();
  try {
    const file = path.join(f.agent, "pi-subagent.json");
    for (const source of ['{"secret":"do-not-expose"', "[]", "null", "42", '{"limits":[]}', '{"limits":null}']) {
      fs.writeFileSync(file, source);
      assert.throws(
        () => saveSubagentSettings(f.project, "global", { PI_SUBAGENT_MAX_TOTAL_AGENTS: "2" }),
        (error: Error) => {
          assert.doesNotMatch(error.message, /do-not-expose/);
          return true;
        },
      );
      assert.equal(fs.readFileSync(file, "utf8"), source);
    }
  } finally {
    f.close();
  }
});

test("invalid encoded settings reject the entire save before writing", () => {
  const f = settingsFixture();
  try {
    f.write(f.agent, { limits: { total: 7 } });
    const file = path.join(f.agent, "pi-subagent.json");
    const source = fs.readFileSync(file, "utf8");
    const invalid: SubagentSettings[] = [
      { PI_SUBAGENT_DISABLED: "1" },
      { PI_SUBAGENT_MAX_DEPTH: "-1" },
      { PI_SUBAGENT_MAX_DEPTH: "1.5" },
      { PI_SUBAGENT_MAX_DEPTH: "" },
      { PI_SUBAGENT_MAX_DEPTH: "9007199254740992" },
      { PI_SUBAGENT_MAX_TOTAL_AGENTS: "invalid setting" },
      { PI_SUBAGENT_EXCLUDE_EXTENSIONS: "a,b" },
      { PI_SUBAGENT_PI_ARGS_PREFIX: '["ok",42]' },
      { PI_SUBAGENT_FALLBACK_MODEL: " " },
      { PI_SUBAGENT_CONFIRM_PROJECT_AGENTS: "always" },
    ];
    for (const settings of invalid) {
      assert.throws(() =>
        saveSubagentSettings(f.project, "global", { PI_SUBAGENT_MAX_TOTAL_AGENTS: "1", ...settings }),
      );
      assert.equal(fs.readFileSync(file, "utf8"), source);
    }
  } finally {
    f.close();
  }
});

test("project runner command and argsPrefix reject without creating or modifying files", () => {
  const f = settingsFixture();
  try {
    const file = path.join(f.project, ".pi", "pi-subagent.json");
    for (const settings of [{ PI_SUBAGENT_PI_COMMAND: "node" }, { PI_SUBAGENT_PI_ARGS_PREFIX: "[]" }]) {
      assert.throws(() => saveSubagentSettings(f.project, "project", settings), /personal-only/);
      assert.equal(fs.existsSync(path.dirname(file)), false);
    }
    f.write(path.dirname(file), { runner: { command: "existing", custom: true } });
    const source = fs.readFileSync(file, "utf8");
    assert.throws(
      () =>
        saveSubagentSettings(f.project, "project", { PI_SUBAGENT_DISABLED: "true", PI_SUBAGENT_PI_COMMAND: "node" }),
      /personal-only/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), source);
    saveSubagentSettings(f.project, "project", { PI_SUBAGENT_STARTUP_TIMEOUT: "0" });
    assert.deepEqual(read(file), { runner: { command: "existing", custom: true, startupTimeoutMs: 0 } });
  } finally {
    f.close();
  }
});

test("saving either scope preserves effective plural config when singular is absent", () => {
  const f = settingsFixture();
  try {
    const original = {
      "tool-prompts": { subagents: "custom prompt" },
      "subagents-models": [{ small: { model: "small", provider: "local", "reasoning-level": "off" } }],
      limits: { total: 7, concurrency: 2 },
      models: { intelligence: true },
      unknown: { preserved: [false, 0] },
    };
    for (const scope of ["global", "project"] as const) {
      const dir = scope === "global" ? f.agent : path.join(f.project, ".pi");
      f.write(dir, original, "pi-subagents.json");
      const plural = path.join(dir, "pi-subagents.json");
      const source = fs.readFileSync(plural, "utf8");
      const before = loadPiSubagentsConfig(f.project, scope === "project");
      const file = saveSubagentSettings(f.project, scope, { PI_SUBAGENT_MAX_TOTAL_AGENTS: "3" });
      assert.equal(file, path.join(dir, scope === "global" ? "pi-subagent.json" : "pi-subagents.json"));
      assert.deepEqual(read(file), { ...original, limits: { ...original.limits, total: 3 } });
      const after = loadPiSubagentsConfig(f.project, scope === "project");
      assert.deepEqual(after.toolPrompts, before.toolPrompts);
      assert.deepEqual(after.intelligencePresets, before.intelligencePresets);
      assert.deepEqual(after.settings, { ...before.settings, PI_SUBAGENT_MAX_TOTAL_AGENTS: "3" });
      if (scope === "global") assert.equal(fs.readFileSync(plural, "utf8"), source);
      else assert.equal(fs.existsSync(path.join(dir, "pi-subagent.json")), false);
    }
  } finally {
    f.close();
  }
});

test("global save honors singular collision priority and does not read malformed shadowed plural", () => {
  const f = settingsFixture();
  try {
    const original = { limits: { total: 7 }, singularOnly: true };
    f.write(f.agent, original);
    const plural = path.join(f.agent, "pi-subagents.json");
    for (const source of [JSON.stringify({ pluralOnly: true, limits: { concurrency: 9 } }), "{invalid"]) {
      fs.writeFileSync(plural, source);
      const file = saveSubagentSettings(f.project, "global", { PI_SUBAGENT_MAX_TOTAL_AGENTS: "3" });
      assert.deepEqual(read(file), { ...original, limits: { total: 3 } });
      assert.equal(fs.readFileSync(plural, "utf8"), source);
    }
  } finally {
    f.close();
  }
});

test("malformed effective plural config throws without creating a singular file", () => {
  const f = settingsFixture();
  try {
    for (const scope of ["global", "project"] as const) {
      const dir = scope === "global" ? f.agent : path.join(f.project, ".pi");
      fs.mkdirSync(dir, { recursive: true });
      const plural = path.join(dir, "pi-subagents.json");
      for (const source of ["{invalid", "[]", "null"]) {
        fs.writeFileSync(plural, source);
        assert.throws(() => saveSubagentSettings(f.project, scope, { PI_SUBAGENT_MAX_TOTAL_AGENTS: "3" }));
        assert.equal(fs.existsSync(path.join(dir, "pi-subagent.json")), false);
        assert.equal(fs.readFileSync(plural, "utf8"), source);
      }
    }
  } finally {
    f.close();
  }
});

test("unknown runtime keys are never persisted and global writes always use the canonical personal path", () => {
  const f = settingsFixture();
  try {
    f.write(f.agent, { legacy: true }, "pi-subagents.json");
    const settings = { PI_SUBAGENT_DEPTH: "10", HOME: "elsewhere" } as SubagentSettings;
    const file = saveSubagentSettings(f.project, "global", settings);
    assert.equal(file, path.join(f.agent, "pi-subagent.json"));
    assert.deepEqual(read(file), { legacy: true });
    assert.deepEqual(read(path.join(f.agent, "pi-subagents.json")), { legacy: true });
  } finally {
    f.close();
  }
});
