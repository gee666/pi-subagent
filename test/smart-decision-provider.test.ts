import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSmartDecisionConfig, selectSmartDecision } from "../runner/smart-decision.js";

const raw = {
  enabled: true,
  model: "jev",
  api_key: "test-key",
  use_models: [{ "provider/strong/high": "Complex tasks", "provider/small/off": "Simple edits" }],
};

test("provider URL defaults and normalizes HTTP, HTTPS, and path prefixes", () => {
  assert.equal(parseSmartDecisionConfig(raw)?.providerUrl, "https://api.typesafe.ai");
  for (const [provider_url, expected] of [
    ["http://localhost:8765", "http://localhost:8765"],
    [" http://localhost:8765/// ", "http://localhost:8765"],
    ["https://example.com/proxy/", "https://example.com/proxy"],
  ]) {
    assert.equal(parseSmartDecisionConfig({ ...raw, provider_url })?.providerUrl, expected);
  }
});

test("invalid provider URLs obey fallback without making requests", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected request");
  });
  const warn = t.mock.method(console, "warn", () => {});
  for (const provider_url of [
    null,
    42,
    "",
    " ",
    "localhost:8765",
    "ftp://host",
    "http://user:pass@host",
    "http://host?key=secret",
    "http://host#fragment",
  ]) {
    const config = parseSmartDecisionConfig({ ...raw, provider_url })!;
    assert.equal(config.invalid, true);
    assert.equal(await selectSmartDecision(config, { systemPrompt: "", task: "test" }), undefined);
    await assert.rejects(
      selectSmartDecision({ ...config, fallback: false }, { systemPrompt: "", task: "test" }),
      /Fallback is disabled/,
    );
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(warn.mock.callCount(), 9);
});

test("custom provider receives the request and hidden-task complexity guidance", async (t) => {
  const config = parseSmartDecisionConfig({ ...raw, provider_url: "http://localhost:8765/" })!;
  const state = {
    systemPrompt: "Implement the assigned task",
    task: "Read tmp/task.md and implement its requirements.",
  };
  const fetch = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(url, "http://localhost:8765/v1/systemone");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.state, state);
    assert.match(body.questions.model.instructions, /contents are not supplied/);
    assert.match(body.questions.model.instructions, /Assume higher complexity/);
    assert.match(body.questions.model.instructions, /source filename alone does not imply hidden requirements/);
    assert.deepEqual(body.questions.model.criteria, raw.use_models[0]);
    return Response.json({ answers: { model: { type: "choice", choice: "provider/strong/high" } } });
  });
  assert.deepEqual(await selectSmartDecision(config, state), {
    provider: "provider",
    model: "strong",
    thinking: "high",
  });
  assert.equal(fetch.mock.callCount(), 1);
});
