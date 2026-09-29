import { Assert } from "@sinclair/typebox/value";
import type { Static, TSchema, TLiteral } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { isBranchBudgetAmount, SubagentBudgetError } from "../budget.js";
import { getTaskBranchSize, sameTasks, type ResumableSubagentCall, type ResumableTask } from "../resume.js";
import { isRecord } from "./contracts.js";
import { intelligenceEnabled, type IntelligencePreset } from "../intelligence.js";

export const TaskItem = Type.Object(
  {
    agent: Type.String({
      description: "Name of an available agent (must match exactly)",
    }),
    task: Type.String({
      description:
        "What to do, what to return, constraints, and known findings or a handoff file path. It cannot see your conversation.",
    }),
    max_subagents_allowed: Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER - 1,
      description:
        "Maximum descendants this worker may launch, including all nested workers but excluding itself. Required on every task. Use 0 for a direct worker; 1 lets it launch one subagent. Count only the descendants the planned work needs. Each task reserves 1 + max_subagents_allowed slots from your budget. Unused slots stay reserved for that worker's future resumes. The sum of these reservations must fit your remaining budget or no tasks launch.",
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
    max_subagents_allowed: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER - 1,
        description:
          "Optional replacement lifetime descendant cap, excluding the resumed worker but including all nested workers. Use 0 for no descendants. Omit to keep its current allowance. Set only what the remaining work needs, while retaining slots already spent or assigned. Increases reserve extra slots from its original launcher's budget. Decreases do not refund reserved slots. Resuming itself uses no slot; the counter never resets.",
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

export function createIntelligenceSchemas(presets: IntelligencePreset[] = []) {
  // Literal alternatives enforce validation; enum and descriptions advertise the caller's choices.
  // The tuple is non-empty whenever these dynamic schemas are exposed.
  const intelligence = {
    intelligence: Type.Optional(
      Type.Union(
        presets.map((preset) => Type.Literal(preset.name, { description: preset.description })) as [
          TLiteral<string>,
          ...TLiteral<string>[],
        ],
        {
          enum: presets.map((preset) => preset.name),
          description: [
            "Optional named model/provider/reasoning preset. Omit to use existing defaults.",
            ...presets.map((preset) => `${preset.name}${preset.description ? `: ${preset.description}` : ""}`),
          ].join("\n"),
        },
      ),
    ),
  };
  const task = Type.Object({ ...TaskItem.properties, ...intelligence }, { additionalProperties: false });
  const resume = Type.Object({ ...ResumeItem.properties, ...intelligence }, { additionalProperties: false });
  const subagents = Type.Object(
    { tasks: Type.Array(task, { minItems: 1, description: SubagentParams.properties.tasks.description }) },
    { additionalProperties: false },
  );
  const resumes = Type.Object(
    {
      resumes: Type.Union([Type.Array(resume, { minItems: 1 }), resume], {
        description: ResumeSubagentsParams.properties.resumes.description,
      }),
    },
    { additionalProperties: false },
  );
  return presets.length >= 2 && intelligenceEnabled(presets)
    ? { subagents, resumes }
    : {
        subagents: SubagentParams as typeof subagents,
        resumes: ResumeSubagentsParams as typeof resumes,
      };
}

export function normalizeResumes(
  raw: unknown,
): Array<{ name: string; task: string; intelligence?: string; max_subagents_allowed?: number }> {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const normalized: Array<{ name: string; task: string; intelligence?: string; max_subagents_allowed?: number }> = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const name =
      typeof item.subagent === "string" ? item.subagent : typeof item.name === "string" ? item.name : undefined;
    const task = typeof item.task === "string" ? item.task : typeof item.prompt === "string" ? item.prompt : undefined;
    if (item.intelligence !== undefined && typeof item.intelligence !== "string") {
      throw new Error("Resume intelligence must be a configured preset name.");
    }
    if (item.max_subagents_allowed !== undefined && !isBranchBudgetAmount(item.max_subagents_allowed)) {
      throw new SubagentBudgetError(
        "Resume max_subagents_allowed must be a non-negative safe integer below Number.MAX_SAFE_INTEGER. Omit it to keep the current allowance.",
      );
    }
    if (name !== undefined && task !== undefined)
      normalized.push({
        name,
        task,
        ...(item.intelligence !== undefined ? { intelligence: item.intelligence } : {}),
        ...(item.max_subagents_allowed !== undefined ? { max_subagents_allowed: item.max_subagents_allowed } : {}),
      });
  }
  return normalized;
}

/** Strict provider schemas can send null for omitted optional intelligence. Leave all other fields alone. */
export function prepareIntelligenceArguments(args: unknown, key: "tasks" | "resumes"): unknown {
  if (!isRecord(args) || !Object.hasOwn(args, key)) return args;
  const omitNull = (item: unknown): unknown => {
    if (!isRecord(item) || item.intelligence !== null) return item;
    const { intelligence: _intelligence, ...rest } = item;
    return rest;
  };
  const items = args[key];
  return { ...args, [key]: Array.isArray(items) ? items.map(omitNull) : omitNull(items) };
}

/** Replay hidden choices through current defaults: a sole preset is automatic, zero/disabled uses no preset. */
export function normalizeRecoveryIntelligence(
  tasks: ResumableTask[],
  presets: IntelligencePreset[] = [],
): ResumableTask[] {
  const exposeChoice = presets.length >= 2 && intelligenceEnabled(presets);
  return tasks.map((task) => {
    if (exposeChoice) return { ...task };
    const { intelligence: _intelligence, ...rest } = task;
    return rest;
  });
}

/** Keep the saved plan intact so recovery reuses its call id, budgets, names, and sessions. */
export function findRecoveryPlanIndex(
  tasks: ResumableTask[],
  plans: ResumableSubagentCall[],
  presets: IntelligencePreset[] = [],
): number {
  const exact = plans.findIndex((plan) => sameTasks(plan.tasks, tasks));
  return exact >= 0
    ? exact
    : plans.findIndex((plan) => sameTasks(normalizeRecoveryIntelligence(plan.tasks, presets), tasks));
}

/** Legacy task arguments and hidden intelligence are accepted only for a matching crash-recovery plan. */
export function prepareRecoveryArguments(
  args: unknown,
  plans: ResumableSubagentCall[],
  presets: IntelligencePreset[] = [],
): unknown {
  if (!isRecord(args) || !Array.isArray(args.tasks)) return args;
  const tasks: unknown[] = args.tasks;
  const isTask = (task: unknown): task is ResumableTask =>
    isRecord(task) &&
    typeof task.agent === "string" &&
    typeof task.task === "string" &&
    ["max_agents_allowed", "max_agents_in_branch", "max_subagents_allowed"].every(
      (key) => task[key] === undefined || typeof task[key] === "number",
    );
  if (!tasks.every(isTask) || findRecoveryPlanIndex(tasks, plans, presets) < 0) return args;
  return {
    ...args,
    tasks: normalizeRecoveryIntelligence(tasks, presets).map((task) => {
      const { max_agents_allowed: _inclusive, max_agents_in_branch: _previous, ...rest } = task;
      return { ...rest, max_subagents_allowed: (getTaskBranchSize(task) ?? 1) - 1 };
    }),
  };
}

/** SDK argument preparation must return a schema-validated value. */
export function validatePreparedArguments<T extends TSchema>(schema: T, value: unknown): Static<T> {
  Assert(schema, value);
  return value;
}
