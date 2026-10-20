import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  RESUME_SUBAGENTS_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  MESSAGE_SUBAGENT_TOOL_NAME,
  STOP_SUBAGENT_TOOL_NAME,
  isSubagentLaunchToolName,
  isSubagentToolName,
} from "../types.js";

describe("tool name helpers", () => {
  it("current launch tool is 'subagents'", () => {
    assert.equal(SUBAGENT_TOOL_NAME, "subagents");
    assert.equal(RESUME_SUBAGENTS_TOOL_NAME, "resume_subagents");
    assert.equal(MESSAGE_SUBAGENT_TOOL_NAME, "message_subagent");
    assert.equal(STOP_SUBAGENT_TOOL_NAME, "stop_subagent");
  });

  it("launch matcher accepts current and legacy names only", () => {
    assert.equal(isSubagentLaunchToolName("subagents"), true);
    assert.equal(isSubagentLaunchToolName("subagent"), true); // legacy sessions
    assert.equal(isSubagentLaunchToolName("resume_subagents"), false);
    assert.equal(isSubagentLaunchToolName("stop_subagent"), false);
    assert.equal(isSubagentLaunchToolName("bash"), false);
    assert.equal(isSubagentLaunchToolName(undefined), false);
  });

  it("general matcher accepts launch, message and stop tools", () => {
    assert.equal(isSubagentToolName("subagents"), true);
    assert.equal(isSubagentToolName("subagent"), true);
    assert.equal(isSubagentToolName("resume_subagents"), true);
    assert.equal(isSubagentToolName("message_subagent"), true);
    assert.equal(isSubagentToolName("stop_subagent"), true);
    assert.equal(isSubagentToolName("bash"), false);
  });
});
