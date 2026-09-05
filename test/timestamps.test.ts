import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildTopLevelNodes, formatClockTime, formatLiveLogEntry, renderTreeLines } from "../tree.js";
import type { SingleResult, SubagentDetails } from "../types.js";
import { emptyUsage } from "../types.js";

const theme = { fg: (_color: string, text: string) => text };

function makeResult(partial: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "writer",
    agentSource: "builtin",
    task: "do things",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    toolCalls: {},
    completedTurns: 0,
    turnInProgress: false,
    liveLog: [],
    ...partial,
  };
}

function makeDetails(results: SingleResult[]): SubagentDetails {
  return {
    mode: "parallel",
    delegationMode: "spawn",
    projectAgentsDir: null,
    results,
    aggregatedUsage: emptyUsage(),
    aggregatedToolCalls: {},
    usageTree: [],
  };
}

describe("formatClockTime", () => {
  it("formats hh:mm:ss with zero padding", () => {
    const d = new Date();
    d.setHours(1, 2, 3, 0);
    assert.equal(formatClockTime(d.getTime()), "01:02:03");
  });
});

describe("formatLiveLogEntry timestamps", () => {
  it("prefixes entries that carry a timestamp", () => {
    const d = new Date();
    d.setHours(9, 8, 7, 0);
    const line = formatLiveLogEntry({ kind: "turn_start", at: d.getTime() }, theme);
    assert.ok(line.startsWith("09:08:07 "), line);
  });

  it("renders entries without timestamps unchanged", () => {
    const line = formatLiveLogEntry({ kind: "turn_start" }, theme);
    assert.ok(line.includes("thinking"), line);
    assert.ok(!/^\d\d:\d\d:\d\d /.test(line), line);
  });
});

describe("tree node start timestamps", () => {
  it("prefixes node lines with the run start time", () => {
    const d = new Date();
    d.setHours(11, 22, 33, 0);
    const nodes = buildTopLevelNodes(makeDetails([makeResult({ startedAt: d.getTime() })]));
    const lines = renderTreeLines(nodes, theme, false);
    assert.ok(lines[0].startsWith("11:22:33 "), lines[0]);
  });

  it("omits the prefix when startedAt is unknown", () => {
    const nodes = buildTopLevelNodes(makeDetails([makeResult()]));
    const lines = renderTreeLines(nodes, theme, false);
    assert.ok(!/^\d\d:\d\d:\d\d /.test(lines[0]), lines[0]);
  });
});

describe("recursive last action", () => {
  it("uses the newest descendant action for the parent", () => {
    const parentAction = Date.now() - 10_000;
    const childAction = Date.now();
    const childDetails = makeDetails([makeResult({ name: "Maria", lastActionAt: childAction })]);
    const parent = makeResult({
      name: "John",
      lastActionAt: parentAction,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "subagents",
              toolCallId: "nested",
              arguments: { tasks: [{ agent: "writer", task: "child work" }] },
            },
          ],
        },
      ],
      liveNestedSubagents: { nested: childDetails },
    });
    const [node] = buildTopLevelNodes(makeDetails([parent]));
    assert.equal(node.lastActionAt, childAction);
  });
});

describe("subagent human names in tree labels", () => {
  it("shows name(type) and keeps source in metadata", () => {
    const nodes = buildTopLevelNodes(makeDetails([makeResult({ name: "John" })]));
    assert.equal(nodes[0].label, "John (writer)");
    assert.ok(nodes[0].meta?.startsWith("builtin"), nodes[0].meta);
  });
});
