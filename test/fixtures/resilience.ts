import { emptyUsage, type SingleResult } from "../../types.js";

export function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "agent",
    agentSource: "user",
    task: "task",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    toolCalls: {},
    completedTurns: 0,
    turnInProgress: false,
    liveLog: [],
    ...overrides,
  };
}
