import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  RESUME_SUBAGENTS_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  isSubagentLaunchToolName,
  isSubagentToolName,
} from "../types.js";

describe("tool name helpers", () => {
  it("current launch tool is 'subagents'", () => {
    assert.equal(SUBAGENT_TOOL_NAME, "subagents");
    assert.equal(RESUME_SUBAGENTS_TOOL_NAME, "resume_subagents");
  });

  it("launch matcher accepts current and legacy names only", () => {
    assert.equal(isSubagentLaunchToolName("subagents"), true);
    assert.equal(isSubagentLaunchToolName("subagent"), true); // legacy sessions
    assert.equal(isSubagentLaunchToolName("resume_subagents"), false);
    assert.equal(isSubagentLaunchToolName("bash"), false);
    assert.equal(isSubagentLaunchToolName(undefined), false);
  });

  it("general matcher accepts launch and resume tools", () => {
    assert.equal(isSubagentToolName("subagents"), true);
    assert.equal(isSubagentToolName("subagent"), true);
    assert.equal(isSubagentToolName("resume_subagents"), true);
    assert.equal(isSubagentToolName("bash"), false);
  });
});
