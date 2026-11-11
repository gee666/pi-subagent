import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectConfig, loadPiSubagentsConfig } from "../config.js";
import { loadSubagentSettings } from "../settings.js";
import { settingsFixture } from "./helpers/settings.js";

function presets(name: string) {
  return [{ [name]: { model: name, provider: "local", "reasoning-level": "off" } }];
}

test("missing settings fall back through every parent before global settings", () => {
  const f = settingsFixture();
  try {
    const parent = path.join(f.project, "parent");
    const current = path.join(parent, "child");
    fs.mkdirSync(current, { recursive: true });
    f.write(f.agent, {
      limits: { total: 50, tasksPerCall: 10, concurrency: 8 },
      "subagents-models": presets("global"),
    });
    f.write(path.join(f.project, ".pi"), {
      limits: { total: 20 },
      "subagents-models": presets("grandparent"),
      "tool-prompts": { subagents: "grandparent", message_subagent: "inherited" },
      runner: { command: "must-not-run" },
    });
    f.write(
      path.join(parent, ".pi"),
      {
        limits: { tasksPerCall: 3 },
        "tool-prompts": { subagents: "parent" },
      },
      "pi-subagents.json",
    );
    f.write(path.join(current, ".pi"), { limits: { concurrency: 1 } });
    const load = () => loadPiSubagentsConfig(current, true);
    const expected = {
      PI_SUBAGENT_MAX_TOTAL_AGENTS: "20",
      PI_SUBAGENT_MAX_TASKS_PER_CALL: "3",
      PI_SUBAGENT_MAX_CONCURRENCY: "1",
    };
    assert.deepEqual(load().settings, expected);
    assert.deepEqual(loadSubagentSettings(current, true), expected);
    assert.equal(load().intelligencePresets[0].name, "grandparent");
    assert.deepEqual(load().toolPrompts, { subagents: "parent", message_subagent: "inherited" });
    assert.equal(findProjectConfig(current), path.join(current, ".pi/pi-subagent.json"));

    f.write(path.join(parent, ".pi"), { "subagents-models": presets("parent") });
    assert.equal(load().intelligencePresets[0].name, "parent");
    f.write(path.join(current, ".pi"), { "subagents-models": presets("current") });
    assert.equal(load().intelligencePresets[0].name, "current");
    fs.rmSync(path.join(current, ".pi"), { recursive: true });
    assert.equal(load().intelligencePresets[0].name, "parent");
    fs.rmSync(path.join(parent, ".pi"), { recursive: true });
    assert.equal(load().intelligencePresets[0].name, "grandparent");
    fs.rmSync(path.join(f.project, ".pi"), { recursive: true });
    assert.equal(load().intelligencePresets[0].name, "global");
    assert.equal(loadPiSubagentsConfig(current, false).intelligencePresets[0].name, "global");
  } finally {
    f.close();
  }
});

test("explicit intelligence disabling blocks inherited presets without disabling other settings", () => {
  const f = settingsFixture();
  try {
    const current = path.join(f.project, "child");
    fs.mkdirSync(current);
    f.write(f.agent, { "subagents-models": presets("global") });
    f.write(path.join(f.project, ".pi"), {
      "subagents-models": presets("parent"),
      limits: { total: 7 },
    });
    const currentPi = path.join(current, ".pi");
    const load = () => loadPiSubagentsConfig(current, true);
    for (const config of [{ models: { intelligence: false } }, { "subagents-models": [] }]) {
      f.write(currentPi, config);
      assert.deepEqual(load().intelligencePresets, []);
      assert.equal(load().settings.PI_SUBAGENT_MAX_TOTAL_AGENTS, "7");
      assert.equal(loadPiSubagentsConfig(current, false).intelligencePresets[0].name, "global");
    }
    f.write(currentPi, {});
    f.write(path.join(f.project, ".pi"), { models: { intelligence: false } });
    assert.deepEqual(load().intelligencePresets, []);
    f.write(currentPi, { models: { intelligence: true } });
    assert.equal(load().intelligencePresets[0].name, "global");
  } finally {
    f.close();
  }
});
