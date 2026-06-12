import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  buildTopLevelNodes,
  formatClockTime,
  formatLiveLogEntry,
  renderTreeLines,
} from "../tree.js";
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

describe("subagent names in tree meta", () => {
  it("shows the resumable name before the agent source", () => {
    const nodes = buildTopLevelNodes(makeDetails([makeResult({ name: "writer-01" })]));
    assert.ok(nodes[0].meta?.startsWith("writer-01 • builtin"), nodes[0].meta);
  });
});
