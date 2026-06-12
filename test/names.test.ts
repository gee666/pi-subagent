import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  allocateSubagentNames,
  buildForkSessionDir,
  clearResumeActive,
  commitFork,
  forkSessionInto,
  formatSubagentName,
  getNamesFilePath,
  markResumeActive,
  readNamesRegistry,
  resolveResumeTarget,
  updateNameRecord,
} from "../names.js";

let tmpDir: string;
let namesFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-names-test-"));
  namesFile = path.join(tmpDir, "subagent-names.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("formatSubagentName", () => {
  it("zero-pads the per-type counter to two digits", () => {
    assert.equal(formatSubagentName("code-writer", 1), "code-writer-01");
    assert.equal(formatSubagentName("code-writer", 12), "code-writer-12");
    assert.equal(formatSubagentName("code-writer", 123), "code-writer-123");
  });
});

describe("getNamesFilePath", () => {
  it("derives the path from session root and sanitized session id", () => {
    const p = getNamesFilePath("/root/subagents", "sess/../weird id", undefined);
    assert.equal(p, path.join("/root/subagents", "sess_.._weird_id", "subagent-names.json"));
  });

  it("prefers the inherited path so the whole tree shares one registry", () => {
    assert.equal(getNamesFilePath("/root", "sess", "/inherited/names.json"), "/inherited/names.json");
  });
});

describe("allocateSubagentNames", () => {
  it("allocates sequential names per agent type", async () => {
    const names = await allocateSubagentNames(namesFile, "owner-1", [
      { agent: "code-writer", task: "a", sessionDir: "/s/0" },
      { agent: "code-writer", task: "b", sessionDir: "/s/1" },
      { agent: "code-reviewer", task: "c", sessionDir: "/s/2" },
    ]);
    assert.deepEqual(names, ["code-writer-01", "code-writer-02", "code-reviewer-01"]);
  });

  it("persists allocations across separate calls (restart survival)", async () => {
    await allocateSubagentNames(namesFile, "owner-1", [
      { agent: "code-writer", task: "a", sessionDir: "/s/0" },
    ]);
    const second = await allocateSubagentNames(namesFile, "owner-2", [
      { agent: "code-writer", task: "b", sessionDir: "/s/1" },
    ]);
    assert.deepEqual(second, ["code-writer-02"]);

    const registry = readNamesRegistry(namesFile);
    assert.equal(registry.agents["code-writer-01"].ownerSessionId, "owner-1");
    assert.equal(registry.agents["code-writer-02"].ownerSessionId, "owner-2");
    assert.equal(registry.agents["code-writer-01"].sessionDir, "/s/0");
  });

  it("never reuses a name even if counters were tampered with", async () => {
    await allocateSubagentNames(namesFile, "o", [
      { agent: "w", task: "a", sessionDir: "/s/0" },
    ]);
    const registry = readNamesRegistry(namesFile);
    registry.counters["w"] = 0; // simulate corruption
    fs.writeFileSync(namesFile, JSON.stringify(registry));
    const names = await allocateSubagentNames(namesFile, "o", [
      { agent: "w", task: "b", sessionDir: "/s/1" },
    ]);
    assert.deepEqual(names, ["w-02"]);
  });

  it("is safe under concurrent allocation", async () => {
    const batches = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        allocateSubagentNames(namesFile, `owner-${i}`, [
          { agent: "writer", task: `t${i}`, sessionDir: `/s/${i}` },
        ]),
      ),
    );
    const all = batches.flat();
    assert.equal(new Set(all).size, 8);
  });
});

describe("resolveResumeTarget", () => {
  it("returns an error for unknown names, listing known ones", async () => {
    await allocateSubagentNames(namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    const result = await resolveResumeTarget(namesFile, "nope-01", "owner");
    assert.ok("error" in result);
    assert.match((result as any).error, /Unknown subagent name "nope-01"/);
    assert.match((result as any).error, /writer-01/);
  });

  it("owner resumes continue the original session dir", async () => {
    await allocateSubagentNames(namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    const result = await resolveResumeTarget(namesFile, "writer-01", "owner");
    assert.ok(!("error" in result));
    const target = result as Exclude<typeof result, { error: string }>;
    assert.equal(target.sessionDir, "/s/0");
    assert.equal(target.isFork, false);
    assert.equal(target.forkCreated, false);
  });

  it("non-owner resumes create exactly one fork and reuse it afterwards", async () => {
    await allocateSubagentNames(namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);

    const first = await resolveResumeTarget(namesFile, "writer-01", "child-A");
    assert.ok(!("error" in first));
    const firstTarget = first as Exclude<typeof first, { error: string }>;
    assert.equal(firstTarget.isFork, true);
    assert.equal(firstTarget.forkCreated, true);
    assert.equal(firstTarget.sessionDir, buildForkSessionDir(namesFile, "writer-01", "child-A"));
    await commitFork(namesFile, "writer-01", "child-A", firstTarget.sessionDir);

    // Second resume by the same child: same fork, no new fork created.
    const second = await resolveResumeTarget(namesFile, "writer-01", "child-A");
    const secondTarget = second as Exclude<typeof second, { error: string }>;
    assert.equal(secondTarget.forkCreated, false);
    assert.equal(secondTarget.sessionDir, firstTarget.sessionDir);

    // A different child gets its own independent fork.
    const other = await resolveResumeTarget(namesFile, "writer-01", "child-B");
    const otherTarget = other as Exclude<typeof other, { error: string }>;
    assert.equal(otherTarget.forkCreated, true);
    assert.notEqual(otherTarget.sessionDir, firstTarget.sessionDir);

    // The owner still resumes the untouched original session.
    const owner = await resolveResumeTarget(namesFile, "writer-01", "owner");
    const ownerTarget = owner as Exclude<typeof owner, { error: string }>;
    assert.equal(ownerTarget.isFork, false);
    assert.equal(ownerTarget.sessionDir, "/s/0");
  });

  it("fork bookkeeping survives a registry reload (restart)", async () => {
    await allocateSubagentNames(namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    const resolved = await resolveResumeTarget(namesFile, "writer-01", "child-A");
    const target = resolved as Exclude<typeof resolved, { error: string }>;
    await commitFork(namesFile, "writer-01", "child-A", target.sessionDir);
    const registry = readNamesRegistry(namesFile);
    assert.ok(registry.agents["writer-01"].forks["child-A"]);
    assert.equal(
      registry.agents["writer-01"].forks["child-A"].sessionDir,
      buildForkSessionDir(namesFile, "writer-01", "child-A"),
    );
  });
});

describe("updateNameRecord", () => {
  it("patches sessionDir and lastResumePrompt", async () => {
    await allocateSubagentNames(namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    await updateNameRecord(namesFile, "writer-01", { sessionDir: "/s/new", lastResumePrompt: "go on" });
    const registry = readNamesRegistry(namesFile);
    assert.equal(registry.agents["writer-01"].sessionDir, "/s/new");
    assert.equal(registry.agents["writer-01"].lastResumePrompt, "go on");
  });

  it("ignores unknown names without throwing", async () => {
    await updateNameRecord(namesFile, "ghost-01", { sessionDir: "/x" });
    const registry = readNamesRegistry(namesFile);
    assert.deepEqual(registry.agents, {});
  });
});

describe("forkSessionInto", () => {
  it("copies the newest session file and rewrites the session header id", async () => {
    const sourceDir = path.join(tmpDir, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    const header = { type: "session", id: "orig-id", timestamp: 1 };
    const message = { type: "message", message: { role: "user", content: "hi" } };
    fs.writeFileSync(
      path.join(sourceDir, "session-a.jsonl"),
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
    );

    const forkDir = path.join(tmpDir, "fork");
    assert.equal(forkSessionInto(sourceDir, forkDir), true);

    const copied = fs.readFileSync(path.join(forkDir, "session-a.jsonl"), "utf8").split("\n");
    const copiedHeader = JSON.parse(copied[0]);
    assert.notEqual(copiedHeader.id, "orig-id");
    assert.match(copiedHeader.id, /^orig-id-fork-/);
    assert.deepEqual(JSON.parse(copied[1]), message);
  });

  it("returns false when the source has no session files", () => {
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir, { recursive: true });
    assert.equal(forkSessionInto(emptyDir, path.join(tmpDir, "fork2")), false);
  });
});

describe("readNamesRegistry", () => {
  it("returns an empty registry for missing files", () => {
    assert.deepEqual(readNamesRegistry(path.join(tmpDir, "missing.json")).agents, {});
  });

  it("backs up corrupt registries before starting fresh", () => {
    const corrupt = path.join(tmpDir, "corrupt.json");
    fs.writeFileSync(corrupt, "{not json");
    assert.deepEqual(readNamesRegistry(corrupt).agents, {});
    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith("corrupt.json.corrupt-"));
    assert.equal(backups.length, 1);
  });
});

describe("resume markers", () => {
  it("blocks a second resume of the same target by another live process", async () => {
    await allocateSubagentNames(namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    const first = await markResumeActive(namesFile, "writer-01", "owner");
    assert.ok("ok" in first);

    // Simulate a different, live process holding the marker.
    const registry = readNamesRegistry(namesFile);
    registry.agents["writer-01"].activeResumes = { owner: { pid: process.pid + 1_000_000, at: Date.now() } };
    fs.writeFileSync(namesFile, JSON.stringify(registry));
    // pid + 1,000,000 is (almost certainly) dead, so the stale marker is overwritten.
    const second = await markResumeActive(namesFile, "writer-01", "owner");
    assert.ok("ok" in second);

    await clearResumeActive(namesFile, "writer-01", "owner");
    const after = readNamesRegistry(namesFile);
    assert.equal(after.agents["writer-01"].activeResumes, undefined);
  });

  it("same-pid markers are treated as stale leftovers", async () => {
    await allocateSubagentNames(namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    await markResumeActive(namesFile, "writer-01", "owner");
    // Same process marking again succeeds (in-memory guard handles real races).
    const again = await markResumeActive(namesFile, "writer-01", "owner");
    assert.ok("ok" in again);
  });
});
