import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const root = process.env.TEST_BROKER_ROOT;
const args = process.argv.slice(2);
const flag = (key) => args[args.indexOf(key) + 1];
const resume = args.includes("--session");
const directory = resume ? path.dirname(flag("--session")) : flag("--session-dir");
fs.mkdirSync(directory, { recursive: true });
const session = resume ? flag("--session") : path.join(directory, "session.jsonl");
if (!fs.existsSync(session))
  fs.writeFileSync(
    session,
    JSON.stringify({
      type: "session",
      version: 3,
      id: `worker-${process.pid}`,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    }) + "\n",
  );
const output = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const log = (value) =>
  fs.appendFileSync(
    path.join(root, "events.jsonl"),
    JSON.stringify({ pid: process.pid, depth: Number(process.env.PI_SUBAGENT_DEPTH), ...value }) + "\n",
  );
const append = (entry) => fs.appendFileSync(session, JSON.stringify(entry) + "\n");
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
const finish = (text) => {
  const message = assistant(text);
  append({
    type: "message",
    id: `answer-${process.pid}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  });
  output({ type: "message_end", message });
  output({ type: "agent_settled" });
};
let state, ctx, tools, handlers;
const depth = Number(process.env.PI_SUBAGENT_DEPTH);
const { openTreeConcurrencyStore } = await import("../../storage/tree-concurrency.ts");
const own = openTreeConcurrencyStore(process.env.PI_SUBAGENT_CONCURRENCY_DIR).get(process.env.PI_SUBAGENT_WORKER_TOKEN);
const ownerName = own.name;
const childNames = Array.from(
  { length: Number(process.env.TEST_BROKER_CHILDREN ?? 1) },
  (_, index) => `${ownerName}-Child-${index}`,
);
log({ kind: "boot", name: ownerName, resume });
if (depth === 1) {
  const { createExtensionState } = await import("../../extension/state.ts");
  const { registerAsyncDeliveryEvents } = await import("../../extension/async-jobs.ts");
  const { restoreBrokerJobs } = await import("../../extension/broker-jobs.ts");
  const { loadSubagentSettings } = await import("../../settings.ts");
  handlers = new Map();
  tools = new Map();
  const pi = {
    getFlag: () => undefined,
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry: (customType, data) =>
      append({
        type: "custom",
        id: `custom-${Date.now()}-${Math.random()}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType,
        data,
      }),
    sendMessage: (message) => {
      const custom = {
        role: "custom",
        customType: message.customType,
        content: message.content,
        details: message.details,
      };
      append({
        type: "message",
        id: `completion-${Date.now()}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: custom,
      });
      log({ kind: "completion", details: message.details, content: message.content });
      for (const handler of handlers.get("message_start") ?? [])
        handler({ type: "message_start", message: custom }, ctx);
      setTimeout(() => finish("parent restored with child result"), 10);
    },
  };
  state = createExtensionState(pi);
  Object.assign(state, {
    sessionActive: true,
    currentSessionId: "parent",
    currentOwnerId: `${ownerName}-owner`,
    currentNamesFile: process.env.PI_SUBAGENT_NAMES_FILE,
    currentSubagentSessionRoot: path.dirname(directory),
    settings: loadSubagentSettings(process.cwd(), true),
  });
  ctx = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "rpc",
    isProjectTrusted: () => true,
    sessionManager: {
      getEntries: () =>
        fs
          .readFileSync(session, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse)
          .filter((entry) => entry.type !== "session"),
      getLeafId: () => null,
      getSessionFile: () => session,
    },
    ui: {
      setStatus: (statusKey, statusText) =>
        output({ type: "extension_ui_request", method: "setStatus", statusKey, statusText }),
    },
  };
  state.latestSessionCtx = ctx;
  registerAsyncDeliveryEvents(state);
  if (!resume) pi.appendEntry("saved-parent-context", { name: ownerName });
  if (resume)
    log({
      kind: "restored",
      name: ownerName,
      context: ctx.sessionManager.getEntries().some((entry) => entry.customType === "saved-parent-context"),
      restored: await restoreBrokerJobs(state, ctx),
    });
}
let prompted = false;
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.type !== "prompt") return;
  output({ type: "response", id: request.id, command: "prompt", success: true });
  if (request.id?.includes("-steer-")) {
    log({ kind: "steer", message: request.message });
    return;
  }
  if (prompted) return;
  prompted = true;
  output({ type: "turn_start" });
  log({ kind: resume ? "resume-prompt" : "initial-prompt", message: request.message });
  if (depth > 1) {
    setTimeout(() => finish("child-result"), 120);
    return;
  }
  if (resume) {
    setTimeout(() => output({ type: "agent_settled" }), 30);
    return;
  }
  const { executeParallel } = await import("../../extension/execution.ts");
  const { startBackground } = await import("../../extension/async-jobs.ts");
  const { makeDetailsFactory } = await import("../../extension/details.ts");
  const { registerMessageSubagentTool } = await import("../../extension/message-tool.ts");
  const agent = { name: "worker", description: "test", systemPrompt: "", source: "user", filePath: "" };
  const budgets = JSON.parse(fs.readFileSync(path.join(root, "budgets.json"), "utf8"));
  startBackground(state, "original-nested-call", childNames, (signal) =>
    executeParallel(
      state,
      childNames.map((name) => ({ agent: "worker", task: `nested-child-task:${name}` })),
      [agent],
      process.cwd(),
      signal,
      undefined,
      makeDetailsFactory(null, "spawn"),
      undefined,
      (index) => path.join(root, `${childNames[index]}-session`),
      false,
      undefined,
      1,
      { jobId: "original-nested-call", names: childNames, budgets: childNames.map((name) => budgets[name]) },
    ),
  );
  registerMessageSubagentTool(state);
  const tool = tools.get("message_subagent");
  const receipt = await tool.execute(
    "queued-steer",
    { name: childNames[0], message: "queued-child-note" },
    undefined,
    undefined,
    ctx,
  );
  log({ kind: "queued-message", content: receipt.content });
  const message = assistant("waiting for child");
  append({
    type: "message",
    id: `waiting-${process.pid}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message,
  });
  output({ type: "message_end", message });
  output({ type: "agent_settled" });
});
setInterval(() => {}, 1000);
