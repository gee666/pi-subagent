import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readCurrentRegistry } from "../extension/expand-command.js";
import { createExtensionState } from "../extension/state.js";
import { emptyNamesRegistry } from "../names.js";

function fixture(t: TestContext) {
  const root = path.join(process.cwd(), "tmp");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "expand-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "names.json");
  const registry = emptyNamesRegistry();
  registry.agents.Anna = {
    name: "Anna",
    agent: "worker",
    task: "work",
    ownerSessionId: "owner",
    sessionDir: "",
    createdAt: 1,
    forks: {},
  };
  fs.writeFileSync(file, JSON.stringify(registry));
  const state = createExtensionState({ getFlag: () => undefined } as unknown as ExtensionAPI);
  state.disabled = false;
  state.currentNamesFile = file;
  return { state, file, dir, registry };
}

test("registry cache reuses parsed references until mtime or size changes", (t) => {
  const { state, file } = fixture(t);
  fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
  const first = readCurrentRegistry(state);
  assert.ok(first);
  assert.strictEqual(readCurrentRegistry(state), first);
  fs.utimesSync(file, 1_700_000_002, 1_700_000_002);
  const touched = readCurrentRegistry(state);
  assert.notStrictEqual(touched, first, "mtime alone invalidates the cached parse");
  assert.strictEqual(readCurrentRegistry(state), touched);
  fs.appendFileSync(file, " ");
  fs.utimesSync(file, 1_700_000_002, 1_700_000_002);
  assert.notStrictEqual(readCurrentRegistry(state), touched, "size alone invalidates the cached parse");
});

test("registry cache is scoped by state, generation, and path", (t) => {
  const { state, file, dir } = fixture(t);
  const first = readCurrentRegistry(state);
  state.lifecycleGeneration++;
  const nextGeneration = readCurrentRegistry(state);
  assert.notStrictEqual(nextGeneration, first);
  const otherState = { ...state };
  assert.notStrictEqual(readCurrentRegistry(otherState), nextGeneration);
  const otherFile = path.join(dir, "other.json");
  fs.copyFileSync(file, otherFile);
  state.currentNamesFile = otherFile;
  const other = readCurrentRegistry(state);
  assert.notStrictEqual(other, nextGeneration);
  assert.strictEqual(readCurrentRegistry(state), other);
  state.currentNamesFile = file;
  assert.notStrictEqual(readCurrentRegistry(state), nextGeneration, "only one path is retained per state");
});

test("disabled, missing, and removed registries never return stale cached records", (t) => {
  const { state, file, registry } = fixture(t);
  const first = readCurrentRegistry(state);
  state.disabled = true;
  assert.equal(readCurrentRegistry(state), undefined);
  state.disabled = false;
  assert.notStrictEqual(readCurrentRegistry(state), first);
  state.currentNamesFile = "";
  assert.equal(readCurrentRegistry(state), undefined);
  state.currentNamesFile = file;
  fs.unlinkSync(file);
  assert.equal(readCurrentRegistry(state), undefined);
  registry.agents.Anna.task = "new work";
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.equal(readCurrentRegistry(state)?.agents.Anna.task, "new work");
});
