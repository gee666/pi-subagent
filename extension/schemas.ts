import type { SubagentSettings } from "../settings.js";
import { DEFAULT_AGENT } from "../agents.js";
import { Value } from "@sinclair/typebox/value";
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
        "One task runs a single worker; multiple tasks run concurrently. Set max_subagents_allowed on every task.",
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
    resumes: Type.Array(ResumeItem, {
      minItems: 1,
      description: "Array of {subagent, task} objects. Each named subagent is resumed in parallel with its new task.",
    }),
  },
  { additionalProperties: false },
);

export function createIntelligenceSchemas(
  presets: IntelligencePreset[] = [],
  settings?: SubagentSettings,
  hasAgentTypes = true,
) {
  // Literal alternatives enforce validation; enum and descriptions advertise the caller's choices.
  // The tuple is non-empty whenever these dynamic schemas are exposed.
  const intelligence = {
    intelligence: Type.Union(
      presets.map((preset) => Type.Literal(preset.name, { description: preset.description })) as [
        TLiteral<string>,
        ...TLiteral<string>[],
      ],
      {
        enum: presets.map((preset) => preset.name),
        description: [
          "Required named model/provider/reasoning preset. Choose a configured preset for every launch.",
          "Use the cheapest capable preset; juniors suit simple repetitive work, pricier models suit complex tasks.",
          ...presets.map((preset) => `${preset.name}${preset.description ? `: ${preset.description}` : ""}`),
        ].join("\n"),
      },
    ),
  };
  const { agent, ...baseFields } = TaskItem.properties;
  // Share an execution type while independently exposing each choice in the schema.
  const executionTask = Type.Object({
    ...baseFields,
    agent: Type.Optional(agent),
    ...intelligence,
  });
  const task = Type.Object(
    {
      ...baseFields,
      ...(hasAgentTypes ? { agent } : {}),
      ...(presets.length >= 2 && intelligenceEnabled(presets, settings) ? intelligence : {}),
    },
    { additionalProperties: false },
  ) as unknown as typeof executionTask;
  const subagents = Type.Object(
    { tasks: Type.Array(task, { minItems: 1, description: SubagentParams.properties.tasks.description }) },
    { additionalProperties: false },
  );
  const resumes = ResumeSubagentsParams;
  return hasAgentTypes && !(presets.length >= 2 && intelligenceEnabled(presets, settings))
    ? { subagents: SubagentParams as unknown as typeof subagents, resumes }
    : { subagents, resumes };
}

export function normalizeResumes(raw: unknown): Array<{ name: string; task: string; max_subagents_allowed?: number }> {
  const items = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const normalized: Array<{ name: string; task: string; max_subagents_allowed?: number }> = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const name =
      typeof item.subagent === "string" ? item.subagent : typeof item.name === "string" ? item.name : undefined;
    const task = typeof item.task === "string" ? item.task : typeof item.prompt === "string" ? item.prompt : undefined;
    if (Object.hasOwn(item, "intelligence")) {
      throw new Error("Resume does not accept intelligence; it retains the original run settings.");
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
        ...(item.max_subagents_allowed !== undefined ? { max_subagents_allowed: item.max_subagents_allowed } : {}),
      });
  }
  return normalized;
}

/** Normalize launch provider nulls to omission. Named resumes never accept intelligence. */
export function prepareIntelligenceArguments(args: unknown, key: "tasks" | "resumes"): unknown {
  if (key === "resumes" || !isRecord(args) || !Object.hasOwn(args, key)) return args;
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
  settings?: SubagentSettings,
): ResumableTask[] {
  const exposeChoice = presets.length >= 2 && intelligenceEnabled(presets, settings);
  return tasks.map((task) => {
    if (exposeChoice) return { ...task };
    const { intelligence: _intelligence, ...rest } = task;
    return rest;
  });
}

// Direct execution can retain prepared object identity. Pi also clones validated
// arguments, so synthetic calls bind their plan separately by tool-call id.
const preparedRecoveryPlans = new WeakMap<object, ResumableSubagentCall>();

export function getPreparedRecoveryPlan(args: object): ResumableSubagentCall | undefined {
  return preparedRecoveryPlans.get(args);
}

function matchingRecoveryPlanIndexes(
  tasks: ResumableTask[],
  plans: ResumableSubagentCall[],
  presets: IntelligencePreset[] = [],
  settings?: SubagentSettings,
  hasAgentTypes = true,
): number[] {
  const exact = plans.flatMap((plan, index) => (sameTasks(plan.tasks, tasks) ? [index] : []));
  const normalize = (items: ResumableTask[]) =>
    normalizeRecoveryIntelligence(items, presets, settings).map((task) =>
      hasAgentTypes ? task : { ...task, agent: DEFAULT_AGENT.name },
    );
  const requested = tasks.map((task) => (hasAgentTypes ? task : { ...task, agent: DEFAULT_AGENT.name }));
  if (exact.length > 0) return exact;
  return plans.flatMap((plan, index) =>
    sameTasks(normalize(plan.tasks), requested) &&
    tasks.every((task, index) => task.agent === DEFAULT_AGENT.name || task.agent === plan.tasks[index].agent)
      ? [index]
      : [],
  );
}

/** Keep the saved plan intact so recovery reuses its call id, budgets, names, and sessions. */
export function findRecoveryPlanIndex(
  tasks: ResumableTask[],
  plans: ResumableSubagentCall[],
  presets: IntelligencePreset[] = [],
  settings?: SubagentSettings,
  hasAgentTypes = true,
): number {
  const matches = matchingRecoveryPlanIndexes(tasks, plans, presets, settings, hasAgentTypes);
  if (matches.length > 1) throw new Error("Ambiguous subagent recovery: a saved tool-call identity is required.");
  return matches[0] ?? -1;
}

/** Legacy task arguments and hidden intelligence are accepted only for a matching crash-recovery plan. */
export function prepareRecoveryArguments(
  args: unknown,
  plans: ResumableSubagentCall[],
  presets: IntelligencePreset[] = [],
  settings?: SubagentSettings,
  hasAgentTypes = true,
): unknown {
  if (!isRecord(args) || !Array.isArray(args.tasks)) return args;
  const tasks: unknown[] = args.tasks.map((task) =>
    !hasAgentTypes && isRecord(task) && task.agent === undefined ? { ...task, agent: DEFAULT_AGENT.name } : task,
  );
  const isTask = (task: unknown): task is ResumableTask =>
    isRecord(task) &&
    typeof task.agent === "string" &&
    typeof task.task === "string" &&
    ["max_agents_allowed", "max_agents_in_branch", "max_subagents_allowed"].every(
      (key) => task[key] === undefined || typeof task[key] === "number",
    );
  if (!tasks.every(isTask)) return args;
  const matches = matchingRecoveryPlanIndexes(tasks, plans, presets, settings, hasAgentTypes);
  if (matches.length === 0) return args;
  const prepared = {
    ...args,
    tasks: normalizeRecoveryIntelligence(tasks, presets, settings).map((task) => {
      const { agent, max_agents_allowed: _inclusive, max_agents_in_branch: _previous, ...rest } = task;
      return {
        ...rest,
        ...(hasAgentTypes ? { agent } : {}),
        max_subagents_allowed: (getTaskBranchSize(task) ?? 1) - 1,
      };
    }),
  };
  // Colliding public payloads need the synthetic provider's tool-call binding.
  if (matches.length === 1) preparedRecoveryPlans.set(prepared, plans[matches[0]]);
  return prepared;
}

/** SDK argument preparation must return a schema-validated value. */
export function validatePreparedArguments<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (Value.Check(schema, value)) return value;
  // Pi aliases TypeBox imports to its installed version. Newer Assert errors say only "Assert".
  // Read validation issues directly so both TypeBox versions report useful paths without echoing input.
  const issues = Array.from(Value.Errors(schema, value), (error) => {
    const at = "instancePath" in error && typeof error.instancePath === "string" ? error.instancePath : error.path;
    const params = "params" in error && isRecord(error.params) ? error.params : {};
    const keys = params.additionalProperties ?? params.requiredProperties;
    const properties = Array.isArray(keys) ? ` (${keys.filter((key) => typeof key === "string").join(", ")})` : "";
    return `${at || "root"}: ${error.message}${properties}`;
  });
  throw new Error(`Invalid tool arguments:\n${issues.join("\n")}`);
}
