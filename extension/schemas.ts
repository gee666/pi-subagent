import { Assert } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { isBranchBudgetAmount, SubagentBudgetError } from "../budget.js";
import { getTaskBranchSize, sameTasks, type ResumableSubagentCall, type ResumableTask } from "../resume.js";
import { isRecord } from "./contracts.js";

export const TaskItem = Type.Object(
  {
    agent: Type.String({
      description: "Name of an available agent (must match exactly)",
    }),
    task: Type.String({
      description:
        "What to do, what to return, constraints, and known findings or a handoff file path. It cannot see your conversation.",
    }),
    max_agents_allowed: Type.Integer({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      description:
        "Maximum total subagents for this task, including the assigned subagent and all nested workers. Required on every task. Use 1 for a direct worker. Otherwise count everyone the planned work actually needs; do not add speculative teams or give each worker the full budget. A value of 10 reserves exactly 10 slots. Unused slots stay reserved for that worker's future resumes. The sum across tasks must fit your remaining budget or no tasks launch.",
    }),
  },
  { additionalProperties: false },
);

export const SubagentParams = Type.Object(
  {
    tasks: Type.Array(TaskItem, {
      minItems: 1,
      description:
        "Array of {agent, task} objects. One task behaves like a single-agent delegation; multiple tasks run concurrently.",
    }),
  },
  { additionalProperties: false },
);

export const ResumeItem = Type.Object(
  {
    subagent: Type.String({
      description: "Unique human name returned by a previous subagents run (e.g. John)",
    }),
    task: Type.String({
      description: "New task for the resumed subagent. It keeps its previous context.",
    }),
    max_agents_allowed: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          "Optional replacement lifetime cap, including the resumed subagent and all nested workers. Omit to keep its current allowance. Set only what the remaining work needs, while retaining slots already spent or assigned. Increases reserve extra slots from its original launcher's budget. Decreases do not refund reserved slots. Resuming itself uses no slot; the counter never resets.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const ResumeSubagentsParams = Type.Object(
  {
    resumes: Type.Union([Type.Array(ResumeItem, { minItems: 1 }), ResumeItem], {
      description: "Array of {subagent, task} objects. Each named subagent is resumed in parallel with its new task.",
    }),
  },
  { additionalProperties: false },
);

export function normalizeResumes(raw: unknown): Array<{ name: string; task: string; max_agents_allowed?: number }> {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const normalized: Array<{ name: string; task: string; max_agents_allowed?: number }> = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const name =
      typeof item.subagent === "string" ? item.subagent : typeof item.name === "string" ? item.name : undefined;
    const task = typeof item.task === "string" ? item.task : typeof item.prompt === "string" ? item.prompt : undefined;
    if (item.max_agents_allowed !== undefined && !isBranchBudgetAmount(item.max_agents_allowed)) {
      throw new SubagentBudgetError(
        "Resume max_agents_allowed must be a positive safe integer. Omit it to keep the current allowance.",
      );
    }
    if (name !== undefined && task !== undefined)
      normalized.push({
        name,
        task,
        ...(item.max_agents_allowed !== undefined ? { max_agents_allowed: item.max_agents_allowed } : {}),
      });
  }
  return normalized;
}

/** Legacy task arguments are accepted only for a matching crash-recovery plan. */
export function prepareRecoveryArguments(args: unknown, plans: ResumableSubagentCall[]): unknown {
  if (!isRecord(args) || !Array.isArray(args.tasks)) return args;
  const tasks: unknown[] = args.tasks;
  const isTask = (task: unknown): task is ResumableTask =>
    isRecord(task) &&
    typeof task.agent === "string" &&
    typeof task.task === "string" &&
    ["max_agents_allowed", "max_agents_in_branch", "max_subagents_allowed"].every(
      (key) => task[key] === undefined || typeof task[key] === "number",
    );
  if (!tasks.every(isTask) || !plans.some((plan) => sameTasks(plan.tasks, tasks))) return args;
  return {
    ...args,
    tasks: tasks.map((task) => {
      const { max_subagents_allowed: _exclusive, max_agents_in_branch: _previous, ...rest } = task;
      return { ...rest, max_agents_allowed: getTaskBranchSize(task) ?? 1 };
    }),
  };
}

/** SDK argument preparation must return a schema-validated value. */
export function validatePreparedArguments<T extends TSchema>(schema: T, value: unknown): Static<T> {
  Assert(schema, value);
  return value;
}
