import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { namesFixture } from "./fixtures/names.js";
import {
  allocateSubagentNames,
  findAncestorNamesFile,
  findPersistedNamesIdentity,
  forkSessionInto,
  SUBAGENT_NAMES_CUSTOM_TYPE,
} from "../names.js";

const fixture = namesFixture();

describe("forkSessionInto", () => {
  it("copies the newest session file and rewrites the session header id", async () => {
    const sourceDir = path.join(fixture.tmpDir, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    const header = { type: "session", id: "orig-id", timestamp: 1 };
    const message = { type: "message", message: { role: "user", content: "hi" } };
    fs.writeFileSync(
      path.join(sourceDir, "session-a.jsonl"),
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
    );

    const forkDir = path.join(fixture.tmpDir, "fork");
    assert.equal(forkSessionInto(sourceDir, forkDir), true);

    const copied = fs.readFileSync(path.join(forkDir, "session-a.jsonl"), "utf8").split("\n");
    const copiedHeader = JSON.parse(copied[0]);
    assert.notEqual(copiedHeader.id, "orig-id");
    assert.match(copiedHeader.id, /^orig-id-fork-/);
    assert.deepEqual(JSON.parse(copied[1]), message);
  });

  it("rewrites persisted names-identity entries so the fork gets its own ownerId", () => {
    const sourceDir = path.join(fixture.tmpDir, "source-id");
    fs.mkdirSync(sourceDir, { recursive: true });
    const header = { type: "session", id: "child-id", timestamp: 1 };
    const identity = {
      type: "custom",
      customType: SUBAGENT_NAMES_CUSTOM_TYPE,
      data: { namesFile: "/tree/names.json", ownerId: "child-owner" },
    };
    fs.writeFileSync(
      path.join(sourceDir, "session-b.jsonl"),
      `${JSON.stringify(header)}\n${JSON.stringify(identity)}\n`,
    );

    const forkDir = path.join(fixture.tmpDir, "fork-id");
    assert.equal(forkSessionInto(sourceDir, forkDir), true);
    const copied = fs.readFileSync(path.join(forkDir, "session-b.jsonl"), "utf8").split("\n");
    const copiedIdentity = JSON.parse(copied[1]);
    assert.equal(copiedIdentity.data.namesFile, "/tree/names.json"); // same tree registry
    assert.notEqual(copiedIdentity.data.ownerId, "child-owner"); // fresh fork identity
    assert.match(copiedIdentity.data.ownerId, /^child-owner-fork-/);
  });

  it("returns false when the source has no session files", () => {
    const emptyDir = path.join(fixture.tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    assert.equal(forkSessionInto(emptyDir, path.join(fixture.tmpDir, "fork2")), false);
  });
});

describe("findPersistedNamesIdentity", () => {
  it("returns the latest valid identity entry", () => {
    const entries = [
      { type: "message", message: {} },
      { type: "custom", customType: SUBAGENT_NAMES_CUSTOM_TYPE, data: { namesFile: "/a.json", ownerId: "one" } },
      { type: "custom", customType: "other-extension", data: { namesFile: "/x.json", ownerId: "x" } },
      { type: "custom", customType: SUBAGENT_NAMES_CUSTOM_TYPE, data: { namesFile: "/b.json", ownerId: "two" } },
    ];
    assert.deepEqual(findPersistedNamesIdentity(entries), { namesFile: "/b.json", ownerId: "two" });
  });

  it("prefers the latest entry whose registry actually has named agents", async () => {
    // Simulates a session damaged by a buggy run: a later identity entry
    // points at an empty registry while an earlier one has the real names.
    const goodFile = path.join(fixture.tmpDir, "good", "subagent-names.json");
    fs.mkdirSync(path.dirname(goodFile), { recursive: true });
    await allocateSubagentNames(goodFile, "owner", [{ agent: "writer", task: "t", sessionDir: "/s/0" }]);
    const emptyFile = path.join(fixture.tmpDir, "empty", "subagent-names.json");
    fs.mkdirSync(path.dirname(emptyFile), { recursive: true });
    fs.writeFileSync(emptyFile, JSON.stringify({ version: 1, counters: {}, agents: {} }));

    const entries = [
      { type: "custom", customType: SUBAGENT_NAMES_CUSTOM_TYPE, data: { namesFile: goodFile, ownerId: "good" } },
      { type: "custom", customType: SUBAGENT_NAMES_CUSTOM_TYPE, data: { namesFile: emptyFile, ownerId: "bad" } },
    ];
    assert.deepEqual(findPersistedNamesIdentity(entries), { namesFile: goodFile, ownerId: "good" });
  });

  it("ignores malformed entries and non-arrays", () => {
    assert.equal(findPersistedNamesIdentity(undefined), undefined);
    assert.equal(
      findPersistedNamesIdentity([{ type: "custom", customType: SUBAGENT_NAMES_CUSTOM_TYPE, data: { ownerId: 5 } }]),
      undefined,
    );
  });
});

describe("findAncestorNamesFile", () => {
  it("finds the registry of an ancestor session via the parentSession chain", () => {
    // Simulate: original session "root-id" created a registry; the session was
    // then resumed/branched twice, producing new ids without registries.
    const sessionRoot = path.join(fixture.tmpDir, "subagents");
    const rootRegistry = path.join(sessionRoot, "root-id", "subagent-names.json");
    fs.mkdirSync(path.dirname(rootRegistry), { recursive: true });
    fs.writeFileSync(rootRegistry, JSON.stringify({ version: 1, counters: {}, agents: {} }));

    const sessionsDir = path.join(fixture.tmpDir, "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const rootFile = path.join(sessionsDir, "root.jsonl");
    fs.writeFileSync(rootFile, `${JSON.stringify({ type: "session", id: "root-id" })}\n`);
    const midFile = path.join(sessionsDir, "mid.jsonl");
    fs.writeFileSync(midFile, `${JSON.stringify({ type: "session", id: "mid-id", parentSession: rootFile })}\n`);

    const found = findAncestorNamesFile(sessionRoot, "leaf-id", {
      type: "session",
      id: "leaf-id",
      parentSession: midFile,
    });
    assert.deepEqual(found, { namesFile: rootRegistry, ownerId: "root-id" });
  });

  it("returns the current session's registry when it exists", () => {
    const sessionRoot = path.join(fixture.tmpDir, "subagents2");
    const ownRegistry = path.join(sessionRoot, "self-id", "subagent-names.json");
    fs.mkdirSync(path.dirname(ownRegistry), { recursive: true });
    fs.writeFileSync(ownRegistry, "{}");
    const found = findAncestorNamesFile(sessionRoot, "self-id", { type: "session", id: "self-id" });
    assert.deepEqual(found, { namesFile: ownRegistry, ownerId: "self-id" });
  });

  it("returns undefined when no ancestor has a registry", () => {
    const found = findAncestorNamesFile(path.join(fixture.tmpDir, "none"), "x", { type: "session", id: "x" });
    assert.equal(found, undefined);
  });
});
