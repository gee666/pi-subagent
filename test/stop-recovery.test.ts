import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { findLatestResumableSubagentCalls } from "../resume.js";
import { buildSubagentDetails } from "../types.js";
import { assistantSubagentCall, makeCtx, makeResult, subagentToolResult, tasks } from "./fixtures/resume.js";
import { messageEntry } from "./helpers/extension.js";
import { serializedDetails } from "./helpers/json.js";

function launch(id = "launch"): SessionEntry[] {
  const results = tasks.map((task, index) =>
    makeResult({
      ...task,
      name: index === 0 ? "Ada" : "Bo",
      sessionDir: `/workers/${index}`,
      exitCode: -1,
    }),
  );
  const details = Object.assign(buildSubagentDetails("parallel", "spawn", null, results), { asyncJobId: id });
  return [assistantSubagentCall(id), subagentToolResult(id, details, false)];
}
function stop(statuses: Array<{ name: string; status: string }>, isError = false): SessionEntry {
  return messageEntry(
    {
      role: "toolResult",
      toolName: "stop_subagent",
      toolCallId: "stop",
      isError,
      content: [{ type: "text", text: "Stopped" }],
      details: serializedDetails(Object.assign(buildSubagentDetails("parallel", "spawn", null, []), { statuses })),
      timestamp: Date.now(),
    },
    "stop-result",
  );
}

test("intentional stops suppress recovery of only those workers, preserving sibling alignment", () => {
  const entries = [...launch(), stop([{ name: "Ada", status: "canceled" }])];
  const [plan] = findLatestResumableSubagentCalls(makeCtx(entries));
  assert.deepEqual(plan.tasks, [tasks[1]]);
  assert.deepEqual(
    plan.details?.results.map((result) => result.name),
    ["Bo"],
  );
  assert.deepEqual(
    findLatestResumableSubagentCalls(makeCtx([...entries, stop([{ name: "Bo", status: "stopped" }])])),
    [],
  );
});

test("successful stops in mixed-error replies still suppress recovery, idle and unknown do not", () => {
  const plans = findLatestResumableSubagentCalls(
    makeCtx([
      ...launch(),
      stop(
        [
          { name: "Ada", status: "stopped" },
          { name: "Missing", status: "unknown" },
        ],
        true,
      ),
      stop([{ name: "Bo", status: "idle" }]),
    ]),
  );
  assert.deepEqual(
    plans[0].details?.results.map((result) => result.name),
    ["Bo"],
  );
});

test("a historical stop does not suppress newly launched work with that name", () => {
  const plans = findLatestResumableSubagentCalls(
    makeCtx([stop([{ name: "Ada", status: "canceled" }]), ...launch("later")]),
  );
  assert.equal(plans[0].tasks.length, 2);
  assert.deepEqual(
    plans[0].details?.results.map((result) => result.name),
    ["Ada", "Bo"],
  );
});
