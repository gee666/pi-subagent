import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSmartDecisionConfig, selectSmartDecision } from "../runner/smart-decision.js";

const raw = {
  enabled: true,
  model: "jev",
  api_key: "secret-test-key",
  use_models: [{ "openai-codex/gpt-6-astra/high": "Hard planning", "other/org/model/off": "Cheap simple edits" }],
};
const state = { systemPrompt: "You are a programmer", task: "Design a database" };
const config = parseSmartDecisionConfig(raw)!;
const answer = (choice = "other/org/model/off") => Response.json({ answers: { model: { type: "choice", choice } } });

test("parses candidate triples, aliases and fallback defaults", () => {
  assert.equal(config.model, "jev-latest");
  assert.equal(config.fallback, true);
  assert.equal(parseSmartDecisionConfig({ ...raw, fallback: false })?.fallback, false);
  assert.equal(parseSmartDecisionConfig({ ...raw, fallback: true })?.fallback, true);
  assert.equal(parseSmartDecisionConfig({ ...raw, model: "jev-1.13.0" })?.model, "jev-1.13.0");
  assert.deepEqual(config.candidates[1], {
    provider: "other",
    model: "org/model",
    thinking: "off",
    key: "other/org/model/off",
    description: "Cheap simple edits",
  });
});

test("missing, disabled and empty settings never call Jev", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected request");
  });
  for (const value of [
    undefined,
    null,
    {},
    { ...raw, enabled: false },
    { ...raw, enabled: "true" },
    { ...raw, use_models: [] },
    { ...raw, use_models: [{}] },
    { enabled: true, fallback: false, use_models: [{}] },
  ]) {
    assert.equal(parseSmartDecisionConfig(value), undefined);
    assert.equal(await selectSmartDecision(parseSmartDecisionConfig(value), state), undefined);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("rejects malformed candidates and oversized choice sets", () => {
  for (const use_models of [
    null,
    {},
    [null],
    [{ "p/m/high": "" }],
    [{ "p/m": "text" }],
    [{ "/m/high": "text" }],
    [{ "p//high": "text" }],
    [{ "p/m/invalid": "text" }],
    [{ "p/a//b/high": "text" }],
    [{ "p/m name/high": "text" }],
    [Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`p/m${i}/low`, "test"]))],
  ]) {
    assert.equal(parseSmartDecisionConfig({ ...raw, use_models })?.invalid, true);
  }
});

test("sends the subagent prompt and criteria and accepts only a configured choice", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret-test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "jev-latest");
    assert.deepEqual(body.state, state);
    assert.equal(body.questions.model.type, "choice");
    assert.deepEqual(body.questions.model.criteria, raw.use_models[0]);
    assert.equal(String(init?.body).includes(raw.api_key), false);
    return answer();
  });
  assert.deepEqual(await selectSmartDecision(config, state), {
    provider: "other",
    model: "org/model",
    thinking: "off",
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("HTTP, transport, JSON, malformed and unlisted answers warn or fail according to fallback", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: unknown) => warnings.push(String(message)));
  const failures = [
    async () => new Response(raw.api_key, { status: 503 }),
    async () => {
      throw new Error(raw.api_key);
    },
    async () => new Response(raw.api_key),
    async () => Response.json({}),
    async () => Response.json({ answers: { model: { type: "score", choice: "other/org/model/off" } } }),
    async () => answer("evil/unconfigured/high"),
  ];
  const fetch = t.mock.method(globalThis, "fetch", failures[0]);
  for (const fail of failures) {
    fetch.mock.mockImplementation(fail);
    assert.equal(await selectSmartDecision(config, state), undefined);
    await assert.rejects(selectSmartDecision({ ...config, fallback: false }, state), /Fallback is disabled/);
  }
  assert.equal(warnings.length, failures.length);
  assert.ok(warnings.every((warning) => warning.includes("default launch settings") && !warning.includes(raw.api_key)));
});

test("external cancellation is silent and does not start another request", async (t) => {
  const warnings = t.mock.method(console, "warn", () => {});
  const controller = new AbortController();
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    controller.abort();
    return new Promise<Response>(() => {});
  });
  assert.equal(await selectSmartDecision({ ...config, fallback: false }, state, controller.signal), undefined);
  assert.equal(await selectSmartDecision(config, state, controller.signal), undefined);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(warnings.mock.callCount(), 0);
});

test("the timeout bounds stalled requests and response bodies in both fallback modes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings = t.mock.method(console, "warn", () => {});
  const fetch = t.mock.method(globalThis, "fetch", async () => new Promise<Response>(() => {}));
  const pending = selectSmartDecision(config, state);
  t.mock.timers.tick(10_000);
  assert.equal(await pending, undefined);
  assert.equal(warnings.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => {
    const response = answer();
    response.json = () => new Promise(() => {});
    return response;
  });
  const strict = selectSmartDecision({ ...config, fallback: false }, state);
  const rejected = assert.rejects(strict, /Fallback is disabled/);
  await Promise.resolve();
  t.mock.timers.tick(10_000);
  await rejected;
});
