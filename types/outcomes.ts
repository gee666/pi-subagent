import type { SingleResult, SubagentDetails } from "./contracts.js";
/** Terminal stop reasons that never represent a complete successful task. */
const INCOMPLETE_STOP_REASONS = new Set(["error", "aborted", "length", "incomplete", "max_tokens"]);

/** Whether a result represents an error or incomplete run. */
export function isResultError(r: SingleResult): boolean {
  // -1 is the live "still running" sentinel, not a failure.
  return r.exitCode > 0 || INCOMPLETE_STOP_REASONS.has(r.stopReason ?? "");
}

/** Whether a result is fully settled and successful. */
export function isResultSuccess(r: SingleResult): boolean {
  return r.exitCode === 0 && !isResultError(r);
}

/** Whether durable details contain any failed/incomplete direct child. */
export function subagentDetailsHaveErrors(value: unknown): boolean {
  return isSubagentDetails(value) && value.results.some((result) => isResultError(result));
}

/** Normalize common legacy/model-generated resume argument shorthands. */
export function prepareResumeArguments(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  if (record.resumes === undefined && typeof record.subagent === "string" && typeof record.task === "string") {
    return {
      resumes: [
        {
          subagent: record.subagent,
          task: record.task,
          ...(record.max_agents_allowed !== undefined ? { max_agents_allowed: record.max_agents_allowed } : {}),
        },
      ],
    };
  }
  if (record.resumes && typeof record.resumes === "object" && !Array.isArray(record.resumes)) {
    return { ...record, resumes: [record.resumes] };
  }
  return args;
}

/** Check whether a value looks like SubagentDetails. */
export function isSubagentDetails(value: unknown): value is SubagentDetails {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<SubagentDetails>;
  return (
    (maybe.mode === "single" || maybe.mode === "parallel") &&
    maybe.delegationMode === "spawn" &&
    Array.isArray(maybe.results)
  );
}
