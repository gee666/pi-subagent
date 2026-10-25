import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

// Pi must never inherit the harness's stdin.
function runPi(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.EVERGREEN_PI_BIN || "pi", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    }, 180_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0, `Pi failed (${code}): ${stderr}\n${stdout}`);
        const events = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => record(JSON.parse(line)));
        assert.ok(!events.some((event) => event.type === "extension_error"), stderr);
        resolve(events);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function toolResult(events: Record<string, unknown>[], name: string): Record<string, unknown> {
  const calls = events.filter((event) => event.type === "tool_execution_end" && event.toolName === name);
  assert.equal(calls.length, 1, `Expected exactly one ${name} call: ${JSON.stringify(events)}`);
  assert.notEqual(calls[0].isError, true, JSON.stringify(calls[0]));
  return record(calls[0].result);
}

function completion(events: Record<string, unknown>[], secret: string): void {
  const messages = events.filter((event) => event.type === "message_end").map((event) => record(event.message));
  assert.ok(
    messages.some(
      (message) => message.customType === "subagent_completion" && JSON.stringify(message).includes(secret),
    ),
    `Worker completion must reach the lead before print exits: ${JSON.stringify(events)}`,
  );
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  assert.ok(last && JSON.stringify(last.content).includes(secret), "Lead must report the worker's answer");
}

test(
  "global Pi delegates asynchronously, delivers completion, and resumes the same named saved worker",
  { timeout: 390_000 },
  async () => {
    const model = process.env.EVERGREEN_E2E_MODEL;
    assert.ok(model, "Set EVERGREEN_E2E_MODEL to an authenticated provider/model[:thinking]");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-evergreen-"));
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir);
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    for (const file of ["auth.json", "models.json"]) {
      const source = path.join(originalAgentDir, file);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(agentDir, file));
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PI[_-]SUBAGENT/.test(key)));
    Object.assign(env, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_SUBAGENT_PI_COMMAND: process.env.EVERGREEN_PI_BIN || "pi",
      PI_SUBAGENT_INTELLIGENCE: "false",
      PI_SUBAGENT_MAX_TOTAL_AGENTS: "1",
    });
    const session = path.join(root, "lead.jsonl");
    const args = [
      "--mode",
      "json",
      "--no-extensions",
      "-e",
      path.resolve("index.ts"),
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-mcp",
      "--approve",
      "--model",
      model,
      "--session",
      session,
    ];
    const secret = `evergreen-${randomUUID()}`;
    fs.writeFileSync(path.join(root, "secret.txt"), secret);
    try {
      const first = await runPi(
        [
          ...args,
          "Use subagents exactly once to launch one worker with max_subagents_allowed 0. Its task: read secret.txt in this directory and reply with its exact contents. Do not read the file yourself. Do not launch other workers. End your turn after launch and let completion steering wake you; then report the worker's answer verbatim.",
        ],
        root,
        env,
      );
      const launch = record(toolResult(first, "subagents").details);
      assert.ok(Array.isArray(launch.results));
      const worker = record(launch.results[0]);
      assert.equal(typeof worker.name, "string");
      assert.equal(typeof worker.sessionDir, "string");
      completion(first, secret);
      fs.unlinkSync(path.join(root, "secret.txt"));
      const second = await runPi(
        [
          ...args,
          `Use message_subagent exactly once to ask ${worker.name}: "What exact contents did you read from secret.txt in your previous task? Reply from memory; the file is gone." Do not launch a new worker. End your turn to await completion steering, then report its answer verbatim.`,
        ],
        root,
        env,
      );
      toolResult(second, "message_subagent");
      assert.ok(!second.some((event) => event.type === "tool_execution_start" && event.toolName === "subagents"));
      completion(second, secret);
      const workerSessions = fs
        .readdirSync(String(worker.sessionDir), { recursive: true })
        .filter((file) => String(file).endsWith(".jsonl"));
      assert.equal(workerSessions.length, 1, "Resuming must reuse the saved worker session");
      const transcript = fs.readFileSync(path.join(String(worker.sessionDir), String(workerSessions[0])), "utf8");
      assert.match(transcript, /previous task/);
      assert.ok(transcript.includes(secret));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
