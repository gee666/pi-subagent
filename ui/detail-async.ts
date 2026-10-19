import {
  asyncJobId,
  getNestedSubagentResults,
  getFinalOutput,
  isResultError,
  isSubagentDetails,
  isSubagentToolName,
  SUBAGENT_COMPLETION_TYPE,
  subagentExecutionId,
  type SubagentDetails,
} from "../types.js";
import type { DetailChildRef, DetailEvent } from "./detail-model.js";
import { asRecord } from "./value.js";

type MessageEvent = Extract<DetailEvent, { type: "message" }>;

function validResults(details: SubagentDetails): boolean {
  return details.results.every((raw) => {
    const result = asRecord(raw);
    return typeof result.exitCode === "number" && Number.isFinite(result.exitCode);
  });
}

export function childrenFromDetails(details: SubagentDetails): DetailChildRef[] {
  return details.results.map((raw) => {
    const result = asRecord(raw);
    return {
      name: typeof result.name === "string" && result.name ? result.name : undefined,
      agent: typeof result.agent === "string" ? result.agent : "unknown agent",
      ...(typeof result.intelligence === "string" && result.intelligence ? { intelligence: result.intelligence } : {}),
      status: result.exitCode === -1 ? "running" : result.exitCode === 0 && !isResultError(raw) ? "success" : "error",
      task: typeof result.task === "string" ? result.task : "",
    };
  });
}

/** Share runtime reconciliation, without adding completion notifications to the tool list. */
export function reconcileTranscriptChildren(history: Record<string, unknown>[]) {
  // Saved transcripts can be truncated or contain malformed notification details.
  const safeHistory = history.filter((message) => !isSubagentDetails(message.details) || validResults(message.details));
  const reconciled = new Map<string, SubagentDetails>();
  for (const nested of getNestedSubagentResults(safeHistory)) {
    if (!reconciled.has(nested.toolCallId)) reconciled.set(nested.toolCallId, nested.details);
  }
  const launches = new Map<string, SubagentDetails>();
  for (const message of safeHistory) {
    if (message.role === "toolResult" && isSubagentToolName(message.toolName) && isSubagentDetails(message.details)) {
      if (typeof message.toolCallId === "string") launches.set(message.toolCallId, message.details);
    }
  }
  const completions = new Map<string, MessageEvent>();
  return {
    children(message: Record<string, unknown>, details: SubagentDetails): DetailChildRef[] {
      const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
      return childrenFromDetails(reconciled.get(id) ?? details);
    },
    completion(message: Record<string, unknown>, text: string, at?: number): MessageEvent | undefined {
      if (message.customType !== SUBAGENT_COMPLETION_TYPE || !isSubagentDetails(message.details)) return;
      const details = message.details;
      if (!details.results.length || !validResults(details)) return;
      const jobId = asyncJobId(details);
      const taskIndex: unknown = Reflect.get(details, "asyncTaskIndex");
      const launch = jobId ? launches.get(jobId) : undefined;
      const hasSlot =
        launch &&
        Number.isInteger(taskIndex) &&
        Number(taskIndex) >= 0 &&
        Number(taskIndex) < launch.results.length &&
        details.results.length === 1;
      const children = childrenFromDetails(details);
      const event: MessageEvent = {
        type: "message",
        label: "COMPLETION",
        text:
          text ||
          details.results
            .map((result, index) => {
              const child = children[index];
              const output =
                (isResultError(result) && (result.errorMessage || result.stderr)) ||
                getFinalOutput(result.messages, result.finalOutput);
              return `${child.name ?? child.agent} ${child.status}${output ? `: ${output}` : ""}`;
            })
            .join("\n"),
        at,
        isError: details.results.some(isResultError),
        // Completions without a launch slot still need an expandable child ref.
        ...(hasSlot ? {} : { children }),
      };
      const executions = details.results.map(subagentExecutionId);
      const key =
        jobId && Number.isInteger(taskIndex) && Number(taskIndex) >= 0 && details.results.length === 1
          ? JSON.stringify([jobId, taskIndex])
          : executions.every(Boolean)
            ? JSON.stringify(executions)
            : undefined;
      if (key) {
        const previous = completions.get(key);
        if (previous) {
          Object.assign(previous, event);
          return;
        }
        completions.set(key, event);
      }
      return event;
    },
  };
}
