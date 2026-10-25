import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { findPersistedBudget, readBudget } from "../budget.js";
import { getDefaultSubagentSessionRoot } from "../resume.js";
import { createExtensionHarness } from "./helpers/extension.js";

test("in-memory sessions initialize their subagent root and budget without --session-dir", async () => {
  fs.mkdirSync(path.join(process.cwd(), "tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp", "no-session-"));
  const variables = {
    PI_CODING_AGENT_DIR: path.join(dir, "agent"),
    PI_SUBAGENT_SESSION_ROOT: "",
    PI_SUBAGENT_BUDGET_DIR: "",
    PI_SUBAGENT_NAMES_FILE: "",
    PI_SUBAGENT_DEPTH: "0",
    PI_SUBAGENT_MAX_TOTAL_AGENTS: "5",
    PI_SUBAGENT_DISABLE_RESUME: "true",
    PI_SUBAGENT_DISABLED: "false",
  };
  const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]));
  Object.assign(process.env, variables);
  const host = createExtensionHarness();
  const entries: SessionEntry[] = [];
  const sessionManager = SessionManager.inMemory(dir);
  const ctx = host.makeCtx(entries, { cwd: dir, hasUI: false, sessionManager });
  try {
    assert.equal(sessionManager.getSessionDir(), "");
    assert.equal(sessionManager.getSessionFile(), undefined);
    const root = path.join(variables.PI_CODING_AGENT_DIR, "sessions", "subagents");
    assert.equal(getDefaultSubagentSessionRoot(ctx), root);

    await host.emit("session_start", { reason: "startup" }, ctx);
    await host.emit("before_agent_start", {}, ctx);
    const budget = findPersistedBudget(entries);
    assert.ok(budget, "session startup must allow budget initialization");
    assert.equal(budget.directory, path.join(root, sessionManager.getSessionId(), "subagent-budget"));
    assert.equal(readBudget(budget).remaining, 5);
    assert.equal(sessionManager.getSessionFile(), undefined);
  } finally {
    await host.emit("session_shutdown", {}, ctx);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
