import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  describeToolArgs,
  getActivityBlock,
  getDetailChildren,
  getToolListRows,
  getTurnTools,
  parseTranscriptMessages,
  renderActivityLines,
  renderTurnToolListLines,
  type SubagentDetail,
} from "../detail.js";
import { buildTopLevelNodes, formatLiveLogEntry } from "../tree.js";
import { SubagentPager } from "../ui/pager.js";
import { formatClockTime } from "../ui/tree-format.js";
import { emptyUsage, type SingleResult } from "../types.js";
import { makeResult } from "./helpers/results.js";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
const user = (content: string) => ({ role: "user", content });
const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const call = (id: string, name: string, args: unknown = {}) => ({ type: "toolCall", id, name, arguments: args });
const details = (results: SingleResult[], extra = {}) => ({
  mode: "parallel" as const,
  delegationMode: "spawn" as const,
  projectAgentsDir: null,
  results,
  aggregatedUsage: emptyUsage(),
  aggregatedToolCalls: {},
  usageTree: [],
  ...extra,
});
const launch = (id: string, results: SingleResult[]) => ({
  role: "toolResult",
  toolName: "subagents",
  toolCallId: id,
  details: details(results, { asyncJobId: id }),
});
const completion = (id: string, index: number, result: SingleResult, content = `${result.name} finished`) => ({
  role: "custom",
  customType: "subagent_completion",
  content,
  details: details([result], { asyncJobId: id, asyncTaskIndex: index }),
});
const worker = (name: string, exitCode = -1) =>
  makeResult({
    name,
    agent: "writer",
    task: "Same task",
    sessionDir: `sessions/${name}`,
    startedAt: 1,
    exitCode,
  });
function parse(history: unknown[]): SubagentDetail {
  return {
    name: "Lead",
    agent: "",
    sessionDir: "",
    forkCount: 0,
    notes: [],
    ...parseTranscriptMessages(history.map((message) => ({ type: "message", message }))),
  };
}

function parallelHistory() {
  return [
    user("Delegate both tasks"),
    assistant(call("job", "subagents")),
    launch("job", [worker("Maria"), worker("Nina")]),
    user("Message from subagent Maria:\nNeed a decision"),
    completion("job", 1, worker("Nina", 1), "Nina failed: tests failed"),
    completion("job", 0, worker("Maria", 0), "Maria finished: implemented"),
    completion("job", 0, worker("Maria", 0), "Maria finished: implemented"),
  ];
}

test("async completions reconcile indexed placeholders without duplicate children or tool calls", () => {
  const history = parallelHistory();
  const original = JSON.stringify(history);
  const detail = parse(history);
  const tools = getTurnTools(getActivityBlock(detail));
  assert.equal(tools.length, 1);
  assert.equal(detail.toolCallCount, 1);
  assert.equal(tools[0].type, "children");
  if (tools[0].type !== "children") return;
  assert.deepEqual(
    tools[0].children.map((child) => [child.name, child.status]),
    [
      ["Maria", "success"],
      ["Nina", "error"],
    ],
  );
  assert.deepEqual(getDetailChildren(detail), tools[0].children);
  assert.equal(getToolListRows(getActivityBlock(detail)).filter((row) => row.kind === "child").length, 2);
  const events = getActivityBlock(detail).events.filter((event) => event.type === "message");
  assert.equal(events.length, 2, "a repeated task completion is one notification");
  assert.equal(detail.usage.turns, 1, "custom messages are not assistant turns");
  assert.equal(detail.usage.cost, 0, "worker usage must not be charged as the lead's own usage");
  assert.equal(JSON.stringify(history), original);
  const screen = renderActivityLines(detail, 120).join("\n");
  assert.match(screen, /MESSAGE 2 • Message from subagent Maria: Need a decision/);
  assert.match(screen, /COMPLETION • Nina failed: tests failed[\s\S]*COMPLETION • Maria finished: implemented/);
  assert.equal((screen.match(/COMPLETION/g) ?? []).length, 2);
  assert.match(
    renderTurnToolListLines(getActivityBlock(detail), 0, 120).join("\n"),
    /✓ Maria \(writer\)[\s\S]*✗ Nina \(writer\)/,
  );

  const parent = makeResult({ exitCode: 0, messages: history });
  const tree = buildTopLevelNodes(details([parent]), { hydrateSessions: false });
  assert.deepEqual(
    tree[0].children.map((child) => child.status),
    ["success", "error"],
  );
});

test("partial completion leaves unfinished siblings running and honors incomplete stop reasons", () => {
  const detail = parse([
    user("Delegate"),
    assistant(call("job", "subagents")),
    launch("job", [worker("Maria"), worker("Nina")]),
    completion("job", 0, { ...worker("Maria", 0), stopReason: "length" }, "Maria hit the output limit"),
  ]);
  assert.deepEqual(
    getDetailChildren(detail).map((child) => child.status),
    ["error", "running"],
  );
  assert.equal(detail.blocks.length, 1, "completion must not create another prompt turn");
});

test("message_subagent acknowledgements stay tools and orphan completions add a child ref", () => {
  const detail = parse([
    user("Continue the review"),
    assistant(call("wake", "message_subagent", { name: "Maria", message: "Review the fix" })),
    { role: "toolResult", toolName: "message_subagent", toolCallId: "wake", content: "started", details: details([]) },
    completion("wake", 0, worker("Maria", 0), "Maria finished: approved"),
  ]);
  assert.equal(getTurnTools(getActivityBlock(detail)).length, 1);
  assert.equal(getTurnTools(getActivityBlock(detail))[0].type, "tool");
  assert.deepEqual(
    getDetailChildren(detail).map((child) => [child.name, child.status]),
    [["Maria", "success"]],
  );
  const screen = renderActivityLines(detail, 120).join("\n");
  assert.match(screen, /TO AGENT • Maria: Review the fix[\s\S]*COMPLETION • Maria finished: approved/);
  assert.doesNotMatch(screen, /TOOLS • message_subagent/);
});

test("a later execution of a durable worker updates one child entry", () => {
  const first = worker("Maria", 0);
  const resumed = { ...worker("Maria", 1), startedAt: 2, task: "Fix the follow-up" };
  const detail = parse([
    user("Work"),
    assistant(call("job", "subagents")),
    launch("job", [worker("Maria")]),
    completion("job", 0, first),
    assistant(call("wake", "message_subagent", { name: "Maria", message: "Fix the follow-up" })),
    { role: "toolResult", toolName: "message_subagent", toolCallId: "wake", details: details([]) },
    completion("wake", 0, resumed, "Maria failed the follow-up"),
  ]);
  assert.equal(getDetailChildren(detail).length, 1);
  assert.equal(getDetailChildren(detail)[0].status, "error");
  assert.equal(getDetailChildren(detail)[0].task, "Fix the follow-up");
  assert.equal(getActivityBlock(detail).events.filter((event) => event.type === "message").length, 2);
});

test("completion payloads without display text retain the final output preview", () => {
  const result = { ...worker("Maria", 0), finalOutput: "Saved final output" };
  const done = { ...completion("job", 0, result), content: undefined };
  const detail = parse([done]);
  assert.match(renderActivityLines(detail, 120).join("\n"), /COMPLETION • Maria success: Saved final output/);
});

test("completion-only histories and completions before acknowledgements remain visible", () => {
  const done = completion("job", 0, worker("Maria", 0), "Maria completed");
  const orphan = parse([done]);
  assert.equal(getDetailChildren(orphan)[0].status, "success");
  assert.equal(getTurnTools(getActivityBlock(orphan)).length, 0);
  const reordered = parse([user("Work"), assistant(call("job", "subagents")), done, launch("job", [worker("Maria")])]);
  assert.equal(getDetailChildren(reordered).length, 1);
  assert.equal(getDetailChildren(reordered)[0].status, "success");
});

test("lead tool messages and incoming steering are compact and preserve historical prompt metadata", () => {
  const detail = parse([
    user("Initial"),
    assistant(call("report", "message_lead_agent", { message: "Found\na blocker" })),
    { role: "toolResult", toolName: "message_lead_agent", toolCallId: "report", content: "queued" },
    user("Please keep working"),
    assistant({ type: "text", text: "Continuing" }),
  ]);
  assert.equal(detail.blocks.length, 2);
  assert.equal(detail.blocks[1].kind, "resume", "historical per-prompt parsing stays compatible");
  const lines = renderActivityLines(detail, 120);
  const screen = lines.join("\n");
  assert.match(screen, /TO LEAD • Found a blocker[\s\S]*MESSAGE 2 • Please keep working/);
  assert.doesNotMatch(screen, /TOOLS • message_lead_agent|Resume #|Turn \d+ of/);
  assert.ok(lines.length < 20);
});

test("messaging argument previews show recipient and content with bounded whitespace", () => {
  assert.equal(
    describeToolArgs("message_subagent", { name: "Maria", message: "Check\n the tests" }),
    "Maria: Check the tests",
  );
  assert.equal(describeToolArgs("message_lead_agent", { message: "Need\n help" }), "Need help");
  assert.equal(
    formatLiveLogEntry(
      { kind: "tool_start", toolName: "message_subagent", args: { name: "Maria", message: "Check\n the tests" } },
      theme,
    ),
    "→ message_subagent  Maria: Check the tests",
  );
  assert.equal(
    formatLiveLogEntry({ kind: "tool_start", toolName: "message_lead_agent", args: { message: "Need help" } }, theme),
    "→ message_lead_agent  Need help",
  );
  const long = formatLiveLogEntry(
    { kind: "tool_start", toolName: "message_subagent", args: { name: "Maria", message: "x".repeat(10_000) } },
    theme,
  );
  assert.ok(long.length < 120);
  assert.equal(
    formatLiveLogEntry(
      { kind: "tool_start", toolName: "resume_subagents", args: { resumes: [{ subagent: "Maria" }] } },
      theme,
    ),
    "→ resume_subagents  Maria",
  );
});

test("malformed and unrelated custom messages cannot create completions or hide valid children", () => {
  const detail = parse([
    user("Work"),
    assistant(call("job", "subagents")),
    launch("job", [worker("Maria")]),
    { role: "custom", customType: "unrelated", content: "not a completion", details: details([worker("Nina", 0)]) },
    { role: "custom", customType: "subagent_completion", content: "invalid", details: { results: [] } },
    { role: "custom", customType: "subagent_completion", details: details([]) },
    { role: "custom", customType: "subagent_completion", details: details([null as unknown as SingleResult]) },
    completion("job", 0, worker("Maria", 0)),
  ]);
  assert.deepEqual(
    getDetailChildren(detail).map((child) => [child.name, child.status]),
    [["Maria", "success"]],
  );
  assert.equal(getActivityBlock(detail).events.filter((event) => event.type === "message").length, 1);
});

test("recovery completions share runtime reconciliation and historical resumes still parse", () => {
  const done = worker("Maria", 0);
  const recovered = parse([
    user("Work"),
    assistant(call("original", "subagents")),
    launch("original", [worker("Maria")]),
    completion("recovery", 0, done),
  ]);
  assert.equal(getDetailChildren(recovered).length, 1);
  assert.equal(getDetailChildren(recovered)[0].status, "success");
  const originalTool = getTurnTools(getActivityBlock(recovered))[0];
  assert.ok(originalTool.type === "children" && originalTool.children[0].status === "success");

  const historical = parse([
    user("Work"),
    assistant(call("old", "resume_subagents", { resumes: [{ subagent: "Maria", task: "Continue" }] })),
    { role: "toolResult", toolName: "resume_subagents", toolCallId: "old", details: details([done]) },
  ]);
  const tools = getTurnTools(getActivityBlock(historical));
  assert.equal(tools.length, 1);
  assert.ok(tools[0].type === "children" && tools[0].toolName === "resume_subagents");
  assert.equal(getDetailChildren(historical)[0].name, "Maria");
});

test("completion notifications support compact timestamps, search, resize and named child expansion", () => {
  const at = Date.UTC(2026, 0, 1, 10, 20, 30);
  const done = completion("job", 0, worker("Maria", 0), `Maria finished: 测试 ${"x".repeat(5000)}`);
  const detail = parse([
    user("Work"),
    assistant(call("job", "subagents")),
    launch("job", [worker("Maria")]),
    { ...done, timestamp: at },
  ]);
  const lines = renderActivityLines(detail, 120);
  const screen = lines.join("\n");
  assert.ok(screen.includes(`COMPLETION • ${formatClockTime(at)} • Maria finished: 测试`));
  assert.ok(screen.length < 1500, "completion bodies should be previews, not full worker transcripts");
  const child = { ...parse([user("Review"), assistant({ type: "text", text: "Child transcript" })]), name: "Maria" };
  const pager = new SubagentPager({
    detail,
    theme,
    getRows: () => 50,
    resolveDetail: () => child,
    requestRender() {},
    onClose() {},
  });
  pager.render(120);
  pager.handleInput("/");
  pager.handleInput("COMPLETION");
  pager.handleInput("\r");
  assert.ok(pager.render(120).map(stripTerminalSequences).join("\n").includes("COMPLETION"));
  pager.handleInput("C");
  pager.render(120);
  pager.handleInput("\r");
  assert.match(pager.render(120).join("\n"), /Maria.*activity[\s\S]*Child transcript/);
  pager.handleInput("\u001b");
  for (const width of [0, 1, 2, 8, 20, 80, 120]) {
    for (const line of pager.render(width)) assert.ok(visibleWidth(line) <= width);
  }
});
