import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectConfig, loadPiSubagentsConfig } from "../config.js";

const settings = [{ junior: { model: "m", provider: "p", "reasoning-level": "high" } }];

test("singular wins at each location, project trust and whole-section precedence are preserved", (t) => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/intelligence-config-"));
  const home = path.join(root, "home");
  const agent = path.join(root, "agent");
  const project = path.join(root, "project");
  const homePi = path.join(home, ".pi");
  const projectPi = path.join(project, ".pi");
  for (const dir of [homePi, agent, projectPi]) fs.mkdirSync(dir, { recursive: true });
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  const oldEnabled = process.env.PI_SUBAGENT_INTELLIGENCE;
  process.env.PI_CODING_AGENT_DIR = agent;
  delete process.env.PI_SUBAGENT_INTELLIGENCE;
  const write = (dir: string, file: string, config: unknown) =>
    fs.writeFileSync(path.join(dir, file), JSON.stringify(config));
  try {
    for (const dir of [homePi, agent, projectPi]) {
      write(dir, "pi-subagents.json", { "tool-prompts": { obsolete: "plural only" }, "subagents-models": [] });
      write(dir, "pi-subagent.json", { "tool-prompts": { source: dir }, "subagents-models": settings });
    }
    assert.equal(loadPiSubagentsConfig(project, false).toolPrompts.source, agent);
    assert.equal(loadPiSubagentsConfig(project, true).toolPrompts.source, projectPi);
    assert.equal(loadPiSubagentsConfig(project, true).toolPrompts.obsolete, undefined);
    assert.equal(loadPiSubagentsConfig(project, true).intelligencePresets[0].name, "junior");
    const nested = path.join(project, "nested", "child");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findProjectConfig(nested), path.join(projectPi, "pi-subagent.json"));
    fs.mkdirSync(path.join(nested, ".pi"));
    write(path.join(nested, ".pi"), "pi-subagents.json", { "subagents-models": [] });
    assert.equal(findProjectConfig(nested), path.join(nested, ".pi/pi-subagents.json"));
    assert.deepEqual(loadPiSubagentsConfig(nested, true).intelligencePresets, []);
    write(projectPi, "pi-subagent.json", { "tool-prompts": { source: "prompts only" } });
    assert.equal(loadPiSubagentsConfig(project, true).intelligencePresets[0].name, "junior");
    for (const invalid of [[], [{ invalid: {} }], false]) {
      write(projectPi, "pi-subagent.json", { "subagents-models": invalid });
      t.mock.method(console, "warn", () => {});
      assert.deepEqual(loadPiSubagentsConfig(project, true).intelligencePresets, []);
      assert.equal(loadPiSubagentsConfig(project, false).intelligencePresets[0].name, "junior");
    }
    fs.rmSync(path.join(agent, "pi-subagent.json"));
    assert.deepEqual(loadPiSubagentsConfig().intelligencePresets, []);
    fs.rmSync(path.join(agent, "pi-subagents.json"));
    assert.equal(loadPiSubagentsConfig().intelligencePresets[0].name, "junior");
    process.env.PI_SUBAGENT_INTELLIGENCE = "0";
    assert.deepEqual(loadPiSubagentsConfig().intelligencePresets, []);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    if (oldEnabled === undefined) delete process.env.PI_SUBAGENT_INTELLIGENCE;
    else process.env.PI_SUBAGENT_INTELLIGENCE = oldEnabled;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("obsolete smart settings cause no writes, requests, or routing", (t) => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/obsolete-config-"));
  fs.mkdirSync(path.join(root, ".pi"));
  const file = path.join(root, ".pi/pi-subagent.json");
  const source = ' {"smart-decision":{"enabled":true,"model":"jev","api_key":"secret"}}\n';
  fs.writeFileSync(file, source);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("must not fetch");
  });
  try {
    const loaded = loadPiSubagentsConfig(root, true);
    assert.equal(Object.hasOwn(loaded, "smartDecision"), false);
    assert.equal(fs.readFileSync(file, "utf8"), source);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
