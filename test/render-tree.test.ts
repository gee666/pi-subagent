import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import {
  buildTopLevelNodes,
  countNodes,
  hasNestedChildren,
  renderTreeLines,
  setBroadcastNumberingActive,
} from "../tree.js";
import type { SingleResult, SubagentDetails } from "../types.js";

import {
  treeDetails,
  theme,
  ARROW,
  THINKING,
  usage,
  runningLeaf,
  completedLeaf,
  teamleadWithRunningChild,
} from "./fixtures/tree.js";

describe("renderTreeLines live activity", () => {
  it("shows live activity for a nested running node even when showOutputPreview is false", () => {
    const nodes = buildTopLevelNodes(teamleadWithRunningChild());

    // Sanity: nesting exists, which in renderResult forces showOutputPreview = false.
    assert.equal(hasNestedChildren(nodes), true);

    const lines = renderTreeLines(nodes, theme, /* showOutputPreview */ false).join("\n");

    // The teamlead's own live activity (its subagent tool_start) must be visible,
    // not just a static status line.
    assert.ok(lines.includes(`${ARROW} subagent`), `expected teamlead live activity in:\n${lines}`);
    // The still-running nested reviewer must appear as a child node.
    assert.ok(lines.includes("code-reviwer"), `expected nested running child in:\n${lines}`);
    // The completed code-writer is still listed.
    assert.ok(lines.includes("code-writer"), `expected completed child in:\n${lines}`);
  });

  it("renders live grandchild progress from liveNestedSubagents for a pending nested call", () => {
    const liveWriter = runningLeaf("code-writer", {
      liveLog: [{ kind: "tool_start", toolName: "edit", args: { path: "/repo/src/LineageNeo4jService.java" } }],
    });
    const lead = runningLeaf("code-architect", {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "subagent",
              toolCallId: "tc-live-writer",
              arguments: { tasks: [{ agent: "code-writer", task: "fix reviewed issues" }] },
            },
          ],
        },
      ],
      liveNestedSubagents: {
        "tc-live-writer": treeDetails([liveWriter]),
      },
    });
    const details = treeDetails([lead]);

    const lines = renderTreeLines(buildTopLevelNodes(details), theme, false).join("\n");

    assert.ok(lines.includes("code-architect"), `expected lead in:\n${lines}`);
    assert.ok(lines.includes("code-writer"), `expected live grandchild in:\n${lines}`);
    assert.ok(lines.includes(`${ARROW} edit`), `expected live grandchild edit activity in:\n${lines}`);
    assert.ok(lines.includes("LineageNeo4jService.java"), `expected edited path preview in:\n${lines}`);
  });

  it("renders the running leaf's thinking + tool calls at any depth", () => {
    // Two-level nesting: parent (running) -> child (running leaf with liveLog).
    const child = runningLeaf("code-writer");
    const parent: SingleResult = {
      agent: "code-architect",
      agentSource: "builtin",
      task: "lead",
      exitCode: -1,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "subagent",
              toolCallId: "tc1",
              arguments: { tasks: [{ agent: "code-writer", task: "write" }] },
            },
          ],
        },
        {
          role: "toolResult",
          toolName: "subagent",
          toolCallId: "tc1",
          isError: false,
          details: {
            mode: "single",
            delegationMode: "spawn",
            projectAgentsDir: null,
            results: [child],
          },
        },
      ],
      stderr: "",
      usage: usage({ turns: 10 }),
      toolCalls: {},
      completedTurns: 10,
      turnInProgress: false,
      liveLog: [],
    };
    const details = treeDetails([parent]);

    const nodes = buildTopLevelNodes(details);
    const lines = renderTreeLines(nodes, theme, false).join("\n");

    assert.ok(lines.includes(THINKING), `expected thinking line in:\n${lines}`);
    assert.ok(lines.includes(`${ARROW} bash`), `expected bash tool_start in:\n${lines}`);
    assert.ok(lines.includes("grep -rn FOO src"), `expected bash arg preview in:\n${lines}`);
  });

  it("reconstructs nested tree from referenced subagent session files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-tree-"));
    try {
      const nestedDetails = {
        mode: "single",
        delegationMode: "spawn",
        projectAgentsDir: null,
        results: [completedLeaf("code-reviwer", "Review done.")],
        aggregatedUsage: usage(),
        aggregatedToolCalls: {},
        usageTree: [],
      } satisfies SubagentDetails;
      const sessionFile = path.join(dir, "session.jsonl");
      fs.writeFileSync(
        sessionFile,
        [
          JSON.stringify({ type: "session", id: "child-session" }),
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  name: "subagent",
                  toolCallId: "nested",
                  arguments: { tasks: [{ agent: "code-reviwer", task: "review" }] },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: "subagent",
              toolCallId: "nested",
              isError: false,
              details: nestedDetails,
            },
          }),
        ].join("\n") + "\n",
      );

      const compactParent = completedLeaf("team-lead", "Lead done.");
      compactParent.messages = [];
      compactParent.sessionDir = dir;
      const details = treeDetails([compactParent]);
      const lines = renderTreeLines(buildTopLevelNodes(details), theme, false).join("\n");

      assert.ok(lines.includes("team-lead"), `expected parent in:\n${lines}`);
      assert.ok(lines.includes("code-reviwer"), `expected nested child reconstructed from session in:\n${lines}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders finalOutput preview when durable details omit full transcript messages", () => {
    const compactCompleted = completedLeaf("code-writer", "Published from compact details.");
    compactCompleted.messages = [];
    const details = treeDetails([compactCompleted]);

    const lines = renderTreeLines(buildTopLevelNodes(details), theme, true).join("\n");

    assert.ok(lines.includes("Published from compact details."), `expected cached final output in:\n${lines}`);
  });

  it("does not emit live activity for completed (non-running) nodes", () => {
    const details = treeDetails([completedLeaf("code-writer", "Done.")]);

    const nodes = buildTopLevelNodes(details);
    // Flat tree -> showOutputPreview would be true in renderResult.
    const lines = renderTreeLines(nodes, theme, true).join("\n");

    assert.ok(!lines.includes(THINKING), `did not expect thinking for completed node:\n${lines}`);
    assert.ok(!lines.includes(`${ARROW} `), `did not expect tool_start for completed node:\n${lines}`);
    // Completed leaf still shows its final output preview.
    assert.ok(lines.includes("Done."), `expected output preview in:\n${lines}`);
  });

  it("keeps the expanded tree visible when live tool arguments are malformed", () => {
    const result = runningLeaf("code-writer", {
      messages: [],
      liveLog: [
        { kind: "turn_start" },
        { kind: "tool_start", toolName: "bash", args: { command: { invalid: true } } },
        { kind: "tool_start", toolName: "read", args: { path: 42 } },
        { kind: "tool_start", toolName: "subagents", args: { tasks: { agent: "not-an-array" } } },
        { kind: "tool_end", toolName: "bash" },
        { kind: "turn_end", turn: 3, inputTokens: 100, outputTokens: 20 },
        { kind: "tool_start", toolName: "edit", args: {} },
      ],
    });
    // Inject malformed persisted data without pretending it satisfies the contracts.
    Reflect.set(result, "messages", [null]);
    Reflect.set(result, "usage", { cost: "invalid" });
    Reflect.set(result.liveLog.at(-1)!, "args", null);
    const details = treeDetails([result]);

    let lines = "";
    assert.doesNotThrow(() => {
      lines = renderTreeLines(buildTopLevelNodes(details), theme, false).join("\n");
    });

    assert.ok(lines.includes("code-writer"), `expected tree node in:\n${lines}`);
    assert.ok(lines.includes(`${ARROW} bash`), `expected malformed bash event in:\n${lines}`);
    assert.ok(lines.includes(`${ARROW} read`), `expected malformed read event in:\n${lines}`);
    assert.ok(lines.includes(`${ARROW} edit`), `expected null-args edit event in:\n${lines}`);
    // buildResultNode enforces the rolling six-line contract even if external
    // details contain a larger liveLog than the runner normally allows.
    assert.ok(!lines.includes(THINKING), `expected oldest activity to be trimmed:\n${lines}`);
  });

  it("renders a safe error node for a malformed result entry", () => {
    const details = treeDetails([]);
    Reflect.set(details, "results", [null, {}]);

    let lines = "";
    assert.doesNotThrow(() => {
      lines = renderTreeLines(buildTopLevelNodes(details), theme, false).join("\n");
    });
    assert.equal(
      lines.split("\n").filter((line) => line.includes("❌ unknown agent")).length,
      2,
      `expected malformed entries to render as errors:\n${lines}`,
    );
  });
});

describe("countNodes", () => {
  it("counts running and finished nodes across nesting", () => {
    const nodes = buildTopLevelNodes(teamleadWithRunningChild());
    const counts = countNodes(nodes);
    // architect (running) + code-writer (done) + code-reviwer (pending/running)
    assert.equal(counts.total, 3);
    assert.equal(counts.running, 2);
    assert.equal(counts.success, 1);
    assert.equal(counts.finished, 1);
  });
});

// Keep global numbering state clean for other test files.
setBroadcastNumberingActive(false);
