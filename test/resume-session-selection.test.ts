import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildPiArgs } from "../runner/arguments.js";
import { resolveSessionTarget } from "../runner/session-target.js";
import { forkSessionInto, SUBAGENT_NAMES_CUSTOM_TYPE } from "../names.js";
import { runAgentSubprocess } from "../runner.js";
import { buildSubagentDetails } from "../types.js";

const agent = { name: "worker", description: "worker", source: "builtin" as const, filePath: "", systemPrompt: "" };
const saved = { model: "saved/model", thinking: "high", intelligence: "senior" };
const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

test("real SDK CLI selection opens private fork context across cwd changes and reuses it on the next resume", () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/resume-selection-"));
  try {
    const originalCwd = path.join(root, "original-project");
    const callerCwd = path.join(root, "different-caller-project");
    const originalDir = path.join(root, "original-session");
    const forkDir = path.join(root, "private-fork");
    for (const dir of [originalCwd, callerCwd, originalDir]) fs.mkdirSync(dir);
    const timestamp = new Date().toISOString();
    const originalEntries = [
      { type: "session", version: 3, id: randomUUID(), timestamp, cwd: originalCwd },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "Initial private assignment", timestamp: Date.now() },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "PRIVATE_CONTEXT_MARKER" }],
          timestamp: Date.now(),
        },
      },
      {
        type: "custom",
        id: "identity",
        parentId: "a1",
        timestamp,
        customType: SUBAGENT_NAMES_CUSTOM_TYPE,
        data: { namesFile: path.join(root, "names.json"), ownerId: "original-owner" },
      },
    ];
    const originalFile = path.join(originalDir, "saved.jsonl");
    fs.writeFileSync(originalFile, originalEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const before = fs.readFileSync(originalFile, "utf8");
    assert.ok(forkSessionInto(originalDir, forkDir));
    const forkFile = path.join(forkDir, "saved.jsonl");
    const target = resolveSessionTarget(callerCwd, forkDir, true, true);
    const args = buildPiArgs(
      agent,
      null,
      "continue",
      forkDir,
      true,
      "changed/parent",
      true,
      undefined,
      undefined,
      saved,
      target.sessionFile,
    ).args;
    assert.equal(flag(args, "--session"), forkFile);
    assert.equal(args.includes("--continue"), false);
    assert.equal(flag(args, "--session-dir"), forkDir);
    // Exercise the installed CLI's actual selection code and real SessionManager, without a model or worker process.
    const sdkEntry = process.env.PI_TEST_SDK_ROOT
      ? pathToFileURL(path.join(process.env.PI_TEST_SDK_ROOT, "dist/index.js")).href
      : import.meta.resolve("@earendil-works/pi-coding-agent");
    const code = `
      const { createSessionManager } = await import(new URL("./main.js", ${JSON.stringify(sdkEntry)}));
      const { SessionManager, SettingsManager } = await import(${JSON.stringify(sdkEntry)});
      const cwd = ${JSON.stringify(callerCwd)}, dir = ${JSON.stringify(forkDir)};
      const legacy = SessionManager.continueRecent(cwd, dir);
      const legacyUsers = legacy.getBranch().filter((entry) => entry.message?.role === 'user').length;
      const selected = await createSessionManager({ session: ${JSON.stringify(flag(args, "--session"))} }, cwd, dir, SettingsManager.inMemory());
      const initialContext = selected.buildSessionContext().messages;
      selected.appendMessage({ role: 'user', content: 'First followup', timestamp: Date.now() });
      selected.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'FIRST_RESUME_MARKER' }], timestamp: Date.now() });
      const next = await createSessionManager({ session: selected.getSessionFile() }, cwd, dir, SettingsManager.inMemory());
      console.log(JSON.stringify({ legacyUsers, file: selected.getSessionFile(), cwd: selected.getCwd(),
        initialContext, nextContext: next.buildSessionContext().messages }));
    `;
    const result = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], {
        cwd: process.cwd(),
        timeout: 15000,
        encoding: "utf8",
        env: { ...process.env, TMPDIR: root },
      }),
    );
    assert.equal(result.legacyUsers, 0, "reproduce --continue silently ignoring the fork's original cwd");
    assert.equal(result.file, forkFile);
    assert.equal(result.cwd, originalCwd, "explicit resume preserves the worker's original workspace");
    assert.equal(target.cwd, result.cwd, "extension discovery and the actual CLI must resolve the same saved cwd");
    assert.equal(result.initialContext[0].content, "Initial private assignment");
    assert.equal(result.initialContext[1].content[0].text, "PRIVATE_CONTEXT_MARKER");
    assert.equal(result.nextContext[0].content, "Initial private assignment");
    assert.equal(result.nextContext.at(-1).content[0].text, "FIRST_RESUME_MARKER");
    const nextArgs = buildPiArgs(
      agent,
      null,
      "second followup",
      forkDir,
      true,
      undefined,
      true,
      undefined,
      undefined,
      saved,
    ).args;
    assert.equal(flag(nextArgs, "--session"), forkFile);
    assert.equal(
      fs.readdirSync(forkDir).filter((file) => file.endsWith(".jsonl")).length,
      1,
      "continuations must append to the copied transcript, not create a fresh session",
    );
    assert.equal(fs.readFileSync(originalFile, "utf8"), before, "the owner's session must remain untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("named resumes with missing saved files fail without spawning or silently starting fresh", async () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/missing-resume-"));
  try {
    for (const sessionDir of [root, path.join(root, "deleted")]) {
      const result = await runAgentSubprocess({
        cwd: process.cwd(),
        agents: [agent],
        agentName: "worker",
        task: "continue",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 1,
        preventCycles: true,
        sessionDir,
        resumeSession: true,
        resumeSettings: saved,
        makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
        piCommandOverride: { command: "must-not-spawn-nonexistent-command" },
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.errorMessage!, /Cannot resume named subagent: no saved session file/);
      assert.doesNotMatch(result.errorMessage!, /ENOENT/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
