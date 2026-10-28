import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--mode") && process.argv.includes("rpc")) {
  // A real child process and RPC transport, without an authenticated provider.
  const args = process.argv.slice(2);
  const sessionFlag = args.includes("--session-dir") ? "--session-dir" : "--session";
  const target = args[args.indexOf(sessionFlag) + 1];
  const directory = sessionFlag === "--session-dir" ? target : path.dirname(target);
  mkdirSync(directory, { recursive: true });
  const session = path.join(directory, "session.jsonl");
  if (!existsSync(session)) writeFileSync(session, JSON.stringify({ type: "session", id: "startup-worker" }) + "\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    if (request.type !== "prompt") return;
    appendFileSync(
      process.env.STARTUP_CHILD_LOG,
      JSON.stringify({ argv: process.argv, cwd: process.cwd(), message: request.message }) + "\n",
    );
    console.log(
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "child runtime verified" }], stopReason: "stop" },
      }),
    );
    console.log(JSON.stringify({ type: "agent_settled" }));
  });
} else {
  const { createExtensionHarness } = await import("../helpers/extension.ts");
  const { validateToolArguments } = await import("@earendil-works/pi-ai");
  const { loadExtensions } = await import(
    new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
  );
  const entry = process.argv[2],
    cwd = process.argv[3];
  const host = createExtensionHarness();
  const entries = [];
  const ctx = host.makeCtx(entries, { cwd, hasUI: false, mode: "rpc", isProjectTrusted: () => true });
  const loaded = await loadExtensions([entry], cwd);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  for (const key of ["appendEntry", "sendMessage", "sendUserMessage", "getActiveTools", "setActiveTools", "setModel"])
    loaded.runtime[key] = host.pi[key];
  const extension = loaded.extensions[0];
  async function emit(type, fields = {}) {
    for (const handler of extension.handlers.get(type) ?? []) await handler({ type, ...fields }, ctx);
  }
  try {
    await emit("session_start", { reason: "startup" });
    const tool = extension.tools.get("subagents").definition;
    const args = tool.prepareArguments({
      tasks: [{ task: "verify the packed child runner", max_subagents_allowed: 0 }],
    });
    const validated = validateToolArguments(tool, {
      type: "toolCall",
      id: "startup-worker",
      name: tool.name,
      arguments: args,
    });
    const started = await tool.execute("startup-worker", validated, undefined, undefined, ctx);
    assert.notEqual(started.isError, true, JSON.stringify(started.content));
    const deadline = Date.now() + 15000;
    while (!host.calls.sentMessages.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(host.calls.sentMessages.length, 1);
    const completion = host.calls.sentMessages[0].message;
    assert.equal(completion.customType, "subagent_completion");
    assert.equal(completion.details.results[0].exitCode, 0);
    console.log("packed child runtime verified");
  } finally {
    await emit("session_shutdown", { reason: "quit" });
  }
}
