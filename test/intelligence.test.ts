import assert from "node:assert/strict";
import { test } from "node:test";
import { intelligenceEnabled, parseIntelligencePresets, selectIntelligence } from "../intelligence.js";
import {
  createIntelligenceSchemas,
  normalizeResumes,
  validatePreparedArguments,
  prepareRecoveryArguments,
  prepareIntelligenceArguments,
} from "../extension/schemas.js";
import { prepareResumeArguments } from "../types.js";
import { sameTasks, findLatestResumableSubagentCall } from "../resume.js";
import { assistantSubagentCall, makeCtx } from "./fixtures/resume.js";

const raw = [
  { junior: { model: "org/model", provider: "custom", "reasoning-level": "high", description: "Small changes" } },
  { "my arbitrary preset": { model: "tiny", provider: "local", "reasoning-level": "off" } },
];
const presets = parseIntelligencePresets(raw);

test("validates complete presets, names, descriptions, and all thinking levels", () => {
  assert.equal(presets[0].thinking, "high");
  assert.equal(selectIntelligence(presets, "my arbitrary preset")?.model, "tiny");
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(
      parseIntelligencePresets([{ x: { model: "m", provider: "p", "reasoning-level": level } }])[0].thinking,
      level,
    );
  }
  assert.deepEqual(parseIntelligencePresets([]), []);
  for (const invalid of [
    null,
    {},
    [null],
    [{}],
    [{ a: {}, b: {} }],
    [...raw, raw[0]],
    [{ " ": raw[0].junior }],
    [{ " padded ": raw[0].junior }],
    ...[
      {},
      { model: "" },
      { provider: 1 },
      { "reasoning-level": "extreme" },
      { description: "" },
      { description: 4 },
    ].map((override) => [
      { x: { ...raw[0].junior, ...override, ...(Object.keys(override).length ? {} : { model: undefined }) } },
    ]),
  ]) {
    assert.throws(() => parseIntelligencePresets(invalid));
  }
  assert.throws(() => selectIntelligence(presets, "missing"), /Unknown/);
  assert.throws(() => selectIntelligence(presets, 7), /Unknown/);
  assert.equal(selectIntelligence(presets, undefined), undefined);
});

test("environment supports boolean enable/disable with valid presets required", () => {
  const previous = process.env.PI_SUBAGENT_INTELLIGENCE;
  try {
    delete process.env.PI_SUBAGENT_INTELLIGENCE;
    assert.equal(intelligenceEnabled(presets), true);
    assert.equal(intelligenceEnabled([]), false);
    for (const value of ["false", "0", "FALSE"]) {
      process.env.PI_SUBAGENT_INTELLIGENCE = value;
      assert.equal(intelligenceEnabled(presets), false);
      assert.throws(() => selectIntelligence(presets, "junior"), /disabled/);
      assert.equal(selectIntelligence(presets, undefined), undefined);
    }
    for (const value of ["true", "1"]) {
      process.env.PI_SUBAGENT_INTELLIGENCE = value;
      assert.equal(intelligenceEnabled(presets), true);
      assert.equal(intelligenceEnabled([]), false);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_INTELLIGENCE;
    else process.env.PI_SUBAGENT_INTELLIGENCE = previous;
  }
});

test("dynamic launch and resume schemas list names and descriptions and reject unknown choices", () => {
  const schemas = createIntelligenceSchemas(presets);
  const task = { agent: "worker", task: "work", max_subagents_allowed: 0, intelligence: "junior" };
  const resume = { subagent: "John", task: "follow up", intelligence: "my arbitrary preset" };
  const field = schemas.subagents.properties.tasks.items.properties.intelligence;
  assert.deepEqual(field.enum, ["junior", "my arbitrary preset"]);
  assert.match(field.description!, /junior: Small changes/);
  assert.deepEqual(validatePreparedArguments(schemas.subagents, { tasks: [task] }), { tasks: [task] });
  for (const resumes of [resume, [resume]])
    assert.deepEqual(validatePreparedArguments(schemas.resumes, { resumes }), { resumes });
  assert.throws(() => validatePreparedArguments(schemas.subagents, { tasks: [{ ...task, intelligence: "missing" }] }));
  assert.throws(() => validatePreparedArguments(schemas.resumes, { resumes: { ...resume, intelligence: 7 } }));
  assert.throws(() => validatePreparedArguments(createIntelligenceSchemas().subagents, { tasks: [task] }));
  assert.throws(() => validatePreparedArguments(createIntelligenceSchemas().resumes, { resumes: resume }));
  assert.deepEqual(normalizeResumes([resume])[0], {
    name: "John",
    task: "follow up",
    intelligence: "my arbitrary preset",
  });
  assert.deepEqual(prepareResumeArguments(resume), { resumes: [resume] });
  assert.throws(() => normalizeResumes([{ ...resume, intelligence: 7 }]), /preset name/);
});

test("preparation treats only null intelligence as omission, including resume shorthands and recovery", () => {
  const task = { agent: "worker", task: "work", max_subagents_allowed: 0 };
  const resume = { subagent: "John", task: "follow up" };
  const input = { tasks: [{ ...task, intelligence: null }] };
  const snapshot = structuredClone(input);
  for (const configured of [presets, []]) {
    const schemas = createIntelligenceSchemas(configured);
    assert.deepEqual(validatePreparedArguments(schemas.subagents, prepareIntelligenceArguments(input, "tasks")), {
      tasks: [task],
    });
    for (const args of [
      { resumes: [{ ...resume, intelligence: null }] },
      { resumes: { ...resume, intelligence: null } },
      { ...resume, intelligence: null },
    ]) {
      assert.deepEqual(
        validatePreparedArguments(
          schemas.resumes,
          prepareIntelligenceArguments(prepareResumeArguments(args), "resumes"),
        ),
        { resumes: [resume] },
      );
    }
    for (const intelligence of ["unknown", 1, false, {}]) {
      assert.throws(() =>
        validatePreparedArguments(
          schemas.subagents,
          prepareIntelligenceArguments({ tasks: [{ ...task, intelligence }] }, "tasks"),
        ),
      );
      assert.throws(() =>
        validatePreparedArguments(
          schemas.resumes,
          prepareIntelligenceArguments({ resumes: [{ ...resume, intelligence }] }, "resumes"),
        ),
      );
    }
    assert.throws(() =>
      validatePreparedArguments(
        schemas.subagents,
        prepareIntelligenceArguments({ tasks: [{ ...task, task: null, intelligence: null }] }, "tasks"),
      ),
    );
    assert.throws(() =>
      validatePreparedArguments(
        schemas.subagents,
        prepareIntelligenceArguments(
          { tasks: [{ ...task, max_subagents_allowed: null, intelligence: null }] },
          "tasks",
        ),
      ),
    );
    assert.throws(() =>
      validatePreparedArguments(
        schemas.resumes,
        prepareIntelligenceArguments(
          { resumes: [{ ...resume, max_subagents_allowed: null, intelligence: null }] },
          "resumes",
        ),
      ),
    );
  }
  assert.deepEqual(input, snapshot, "preparation must not mutate caller arguments");
  const legacy = { tasks: [{ agent: "worker", task: "work", max_agents_allowed: 1, intelligence: null }] };
  const plan = { previousToolCallId: "recover", tasks: [task] };
  assert.deepEqual(prepareRecoveryArguments(prepareIntelligenceArguments(legacy, "tasks"), [plan]), { tasks: [task] });
});

test("recovery discovers persisted null intelligence as omission without dropping launches or batches", () => {
  const omitted = { agent: "worker", task: "work", max_subagents_allowed: 0 };
  const selected = { agent: "reviewer", task: "review", intelligence: "junior", max_subagents_allowed: 1 };
  for (const recorded of [
    [{ ...omitted, intelligence: null }],
    [{ ...omitted, intelligence: null }, selected, { ...omitted, task: "other work" }],
  ]) {
    const snapshot = structuredClone(recorded);
    const plan = findLatestResumableSubagentCall(makeCtx([assistantSubagentCall("recorded-null", recorded)]));
    const expected = recorded.map((task) => {
      const { intelligence, ...rest } = task;
      return { ...rest, ...(intelligence != null ? { intelligence } : {}) };
    });
    assert.ok(plan, "recorded optional null must not discard the recovery plan");
    assert.deepEqual(plan.tasks, expected);
    assert.equal(sameTasks(plan.tasks, expected), true);
    assert.deepEqual(recorded, snapshot, "discovery must not modify recorded arguments");
  }
  for (const intelligence of [7, false, {}]) {
    assert.equal(
      findLatestResumableSubagentCall(
        makeCtx([assistantSubagentCall("invalid", [{ ...omitted, intelligence }, selected])]),
      ),
      null,
    );
  }
});

test("crash recovery preserves the choice and does not match a differently selected task", () => {
  const tasks = [{ agent: "worker", task: "work", intelligence: "junior", max_subagents_allowed: 0 }];
  const plan = findLatestResumableSubagentCall(makeCtx([assistantSubagentCall("chosen", tasks)]));
  assert.deepEqual(plan?.tasks, tasks);
  assert.equal(sameTasks(tasks, [{ ...tasks[0], intelligence: "other" }]), false);
  assert.equal(sameTasks(tasks, [{ agent: "worker", task: "work", max_subagents_allowed: 0 }]), false);
  assert.deepEqual(prepareRecoveryArguments({ tasks }, [plan!]), { tasks });
});
