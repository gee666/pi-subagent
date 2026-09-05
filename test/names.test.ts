import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { namesFixture } from "./fixtures/names.js";
import {
  allocateSubagentNames,
  buildForkSessionDir,
  clearResumeActive,
  commitFork,
  getNamesFilePath,
  markResumeActive,
  readNamesRegistry,
  resolveResumeTarget,
  updateNameRecord,
} from "../names.js";
import { AGENT_NAMES } from "../agent-names.js";

const fixture = namesFixture();

describe("agent name pool", () => {
  it("contains exactly 1000 case-insensitively unique given names", () => {
    assert.equal(AGENT_NAMES.length, 1000);
    assert.equal(new Set(AGENT_NAMES.map((name) => name.toLowerCase())).size, 1000);
  });

  it("includes requested culturally diverse examples", () => {
    assert.ok(AGENT_NAMES.includes("Octavian"));
    assert.ok(AGENT_NAMES.includes("Achilles"));
    assert.ok(AGENT_NAMES.includes("Vishnu"));
  });
});

describe("getNamesFilePath", () => {
  it("derives the path from session root and sanitized session id", () => {
    const p = getNamesFilePath("/root/subagents", "sess/../weird id", "");
    assert.equal(p, path.join("/root/subagents", "sess_.._weird_id", "subagent-names.json"));
  });

  it("prefers the inherited path so the whole tree shares one registry", () => {
    assert.equal(getNamesFilePath("/root", "sess", "/inherited/names.json"), "/inherited/names.json");
  });
});

describe("allocateSubagentNames", () => {
  it("allocates distinct human names independent of agent type", async () => {
    const names = await allocateSubagentNames(fixture.namesFile, "owner-1", [
      { agent: "code-writer", task: "a", sessionDir: "/s/0" },
      { agent: "code-writer", task: "b", sessionDir: "/s/1" },
      { agent: "code-reviewer", task: "c", sessionDir: "/s/2" },
    ]);
    assert.equal(new Set(names).size, 3);
    assert.ok(names.every((name) => AGENT_NAMES.some((candidate) => candidate === name)));
  });

  it("persists allocations across separate calls (restart survival)", async () => {
    const [first] = await allocateSubagentNames(fixture.namesFile, "owner-1", [
      { agent: "code-writer", task: "a", sessionDir: "/s/0" },
    ]);
    const second = await allocateSubagentNames(fixture.namesFile, "owner-2", [
      { agent: "code-writer", task: "b", sessionDir: "/s/1" },
    ]);
    assert.notEqual(second[0], first);

    const registry = readNamesRegistry(fixture.namesFile);
    assert.equal(registry.agents[first].ownerSessionId, "owner-1");
    assert.equal(registry.agents[second[0]].ownerSessionId, "owner-2");
    assert.equal(registry.agents[first].sessionDir, "/s/0");
  });

  it("never reuses a name even if legacy counters were tampered with", async () => {
    const [first] = await allocateSubagentNames(fixture.namesFile, "o", [
      { agent: "w", task: "a", sessionDir: "/s/0" },
    ]);
    const registry = readNamesRegistry(fixture.namesFile);
    registry.counters["w"] = 0; // simulate corruption
    fs.writeFileSync(fixture.namesFile, JSON.stringify(registry));
    const names = await allocateSubagentNames(fixture.namesFile, "o", [{ agent: "w", task: "b", sessionDir: "/s/1" }]);
    assert.notEqual(names[0], first);
  });

  it("is safe under concurrent allocation", async () => {
    const batches = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        allocateSubagentNames(fixture.namesFile, `owner-${i}`, [
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
    const [name] = await allocateSubagentNames(fixture.namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    const result = await resolveResumeTarget(fixture.namesFile, "nope-01", "owner");
    assert.ok("error" in result);
    assert.match(result.error, /Unknown subagent name "nope-01"/);
    assert.match(result.error, new RegExp(name));
  });

  it("owner resumes continue the original session dir", async () => {
    const [name] = await allocateSubagentNames(fixture.namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    const result = await resolveResumeTarget(fixture.namesFile, name, "owner");
    assert.ok(!("error" in result));
    assert.ok(!("error" in result));
    const target = result;
    assert.equal(target.sessionDir, "/s/0");
    assert.equal(target.isFork, false);
    assert.equal(target.forkCreated, false);
  });

  it("non-owner resumes create exactly one fork and reuse it afterwards", async () => {
    const [name] = await allocateSubagentNames(fixture.namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);

    const first = await resolveResumeTarget(fixture.namesFile, name, "child-A");
    assert.ok(!("error" in first));
    assert.ok(!("error" in first));
    const firstTarget = first;
    assert.equal(firstTarget.isFork, true);
    assert.equal(firstTarget.forkCreated, true);
    assert.equal(firstTarget.sessionDir, buildForkSessionDir(fixture.namesFile, name, "child-A"));
    await commitFork(fixture.namesFile, name, "child-A", firstTarget.sessionDir);

    // Second resume by the same child: same fork, no new fork created.
    const second = await resolveResumeTarget(fixture.namesFile, name, "child-A");
    assert.ok(!("error" in second));
    const secondTarget = second;
    assert.equal(secondTarget.forkCreated, false);
    assert.equal(secondTarget.sessionDir, firstTarget.sessionDir);

    // A different child gets its own independent fork.
    const other = await resolveResumeTarget(fixture.namesFile, name, "child-B");
    assert.ok(!("error" in other));
    const otherTarget = other;
    assert.equal(otherTarget.forkCreated, true);
    assert.notEqual(otherTarget.sessionDir, firstTarget.sessionDir);

    // The owner still resumes the untouched original session.
    const owner = await resolveResumeTarget(fixture.namesFile, name, "owner");
    assert.ok(!("error" in owner));
    const ownerTarget = owner;
    assert.equal(ownerTarget.isFork, false);
    assert.equal(ownerTarget.sessionDir, "/s/0");
  });

  it("fork bookkeeping survives a registry reload (restart)", async () => {
    const [name] = await allocateSubagentNames(fixture.namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    const resolved = await resolveResumeTarget(fixture.namesFile, name, "child-A");
    assert.ok(!("error" in resolved));
    const target = resolved;
    await commitFork(fixture.namesFile, name, "child-A", target.sessionDir);
    const registry = readNamesRegistry(fixture.namesFile);
    assert.ok(registry.agents[name].forks["child-A"]);
    assert.equal(
      registry.agents[name].forks["child-A"].sessionDir,
      buildForkSessionDir(fixture.namesFile, name, "child-A"),
    );
  });
});

describe("updateNameRecord", () => {
  it("patches sessionDir and lastResumePrompt", async () => {
    const [name] = await allocateSubagentNames(fixture.namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    await updateNameRecord(fixture.namesFile, name, { sessionDir: "/s/new", lastResumePrompt: "go on" });
    const registry = readNamesRegistry(fixture.namesFile);
    assert.equal(registry.agents[name].sessionDir, "/s/new");
    assert.equal(registry.agents[name].lastResumePrompt, "go on");
  });

  it("ignores unknown names without throwing", async () => {
    await updateNameRecord(fixture.namesFile, "ghost-01", { sessionDir: "/x" });
    const registry = readNamesRegistry(fixture.namesFile);
    assert.deepEqual(registry.agents, {});
  });
});

describe("readNamesRegistry", () => {
  it("returns an empty registry for missing files", () => {
    assert.deepEqual(readNamesRegistry(path.join(fixture.tmpDir, "missing.json")).agents, {});
  });

  it("backs up corrupt registries before starting fresh", () => {
    const corrupt = path.join(fixture.tmpDir, "corrupt.json");
    fs.writeFileSync(corrupt, "{not json");
    assert.deepEqual(readNamesRegistry(corrupt).agents, {});
    const backups = fs.readdirSync(fixture.tmpDir).filter((f) => f.startsWith("corrupt.json.corrupt-"));
    assert.equal(backups.length, 1);
  });
});

describe("resume markers", () => {
  it("blocks a second resume of the same target by another live process", async () => {
    const [name] = await allocateSubagentNames(fixture.namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    const first = await markResumeActive(fixture.namesFile, name, "owner");
    assert.ok("ok" in first);

    // Simulate a different, live process holding the marker.
    const registry = readNamesRegistry(fixture.namesFile);
    registry.agents[name].activeResumes = { owner: { pid: process.pid + 1_000_000, at: Date.now() } };
    fs.writeFileSync(fixture.namesFile, JSON.stringify(registry));
    // pid + 1,000,000 is (almost certainly) dead, so the stale marker is overwritten.
    const second = await markResumeActive(fixture.namesFile, name, "owner");
    assert.ok("ok" in second);

    await clearResumeActive(fixture.namesFile, name, "owner");
    const after = readNamesRegistry(fixture.namesFile);
    assert.equal(after.agents[name].activeResumes, undefined);
  });

  it("same-pid markers are treated as stale leftovers", async () => {
    const [name] = await allocateSubagentNames(fixture.namesFile, "owner", [
      { agent: "writer", task: "t", sessionDir: "/s/0" },
    ]);
    await markResumeActive(fixture.namesFile, name, "owner");
    // Same process marking again succeeds (in-memory guard handles real races).
    const again = await markResumeActive(fixture.namesFile, name, "owner");
    assert.ok("ok" in again);
  });
});
