import { buildSubagentDetails, type SingleResult, type SubagentDetails, type UsageStats } from "../../types.js";

// Identity theme: fg returns the text unchanged so we can assert raw content.
export function treeDetails(results: SingleResult[]): SubagentDetails {
  return { ...buildSubagentDetails("single", "spawn", null, results), results };
}

export const theme = { fg: (_color: string, text: string) => text };

export const ARROW = "\u2192"; // tool_start glyph
export const THINKING = "thinking\u2026"; // turn_start text

export function usage(partial: Partial<UsageStats> = {}): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
    ...partial,
  };
}

export function runningLeaf(agent: string, overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent,
    agentSource: "builtin",
    task: `do ${agent} work`,
    exitCode: -1, // running
    messages: [],
    stderr: "",
    usage: usage({ turns: 2 }),
    toolCalls: {},
    completedTurns: 2,
    turnInProgress: true,
    liveLog: [{ kind: "turn_start" }, { kind: "tool_start", toolName: "bash", args: { command: "grep -rn FOO src" } }],
    ...overrides,
  };
}

export function completedLeaf(agent: string, finalText: string): SingleResult {
  return {
    agent,
    agentSource: "builtin",
    task: `do ${agent} work`,
    exitCode: 0,
    finalOutput: finalText,
    messages: [{ role: "assistant", content: [{ type: "text", text: finalText }] }],
    stderr: "",
    usage: usage({ turns: 4 }),
    toolCalls: {},
    completedTurns: 4,
    turnInProgress: false,
    // A completed agent keeps no live log; ensure it stays quiet even though
    // live rendering is now decoupled from showOutputPreview.
    liveLog: [],
  };
}

/** A teamlead (running) whose nested subagent batch is still in progress. */
export function teamleadWithRunningChild(): SubagentDetails {
  const lead: SingleResult = {
    agent: "code-architect",
    agentSource: "builtin",
    task: "lead WS5",
    exitCode: -1, // running, blocked on its child
    messages: [
      // completed nested code-writer: assistant call + matching toolResult
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "subagent",
            toolCallId: "tc-done",
            arguments: { tasks: [{ agent: "code-writer", task: "write WS5" }] },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "subagent",
        toolCallId: "tc-done",
        isError: false,
        details: {
          mode: "single",
          delegationMode: "spawn",
          projectAgentsDir: null,
          results: [completedLeaf("code-writer", "All files written.")],
        },
      },
      // still-running nested call: shows up as a pending child node
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "subagent",
            toolCallId: "tc-running",
            arguments: { tasks: [{ agent: "code-reviwer", task: "review WS5" }] },
          },
        ],
      },
    ],
    stderr: "",
    usage: usage({ turns: 28 }),
    toolCalls: {},
    completedTurns: 28,
    turnInProgress: true,
    // The teamlead's own live log — this is what was previously hidden.
    liveLog: [{ kind: "tool_start", toolName: "subagent", args: { tasks: [{ agent: "code-reviwer" }] } }],
  };

  return treeDetails([lead]);
}
