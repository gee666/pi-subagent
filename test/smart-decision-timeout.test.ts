import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSmartDecisionConfig, selectSmartDecision } from "../runner/smart-decision.js";

const raw = { enabled: true, model: "jev", api_key: "secret", use_models: [{ "p/m/off": "Simple tasks" }] };

test("Jev timeout defaults to 1200 seconds and validates overrides", () => {
  assert.equal(parseSmartDecisionConfig(raw)?.timeoutSeconds, 1200);
  for (const timeout_seconds of [0.001, 30, 1200, 2_147_483.647]) {
    assert.equal(parseSmartDecisionConfig({ ...raw, timeout_seconds })?.timeoutSeconds, timeout_seconds);
  }
  for (const timeout_seconds of [null, "1200", 0, -1, 0.0001, Infinity, NaN, 2_147_483.648]) {
    assert.equal(parseSmartDecisionConfig({ ...raw, timeout_seconds })?.invalid, true);
  }
});

for (const timeout_seconds of [undefined, 2]) {
  for (const phase of ["fetch", "body"]) {
    for (const fallback of [true, false]) {
      test(`Jev timeout ${timeout_seconds ?? "default"}, stalled ${phase}, fallback ${fallback}`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const warn = t.mock.method(console, "warn", () => {});
        let requestSignal: AbortSignal | null | undefined;
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
          requestSignal = init?.signal;
          if (phase === "fetch") {
            started();
            return new Promise<Response>(() => {});
          }
          return {
            ok: true,
            json: () => {
              started();
              return new Promise(() => {});
            },
          } as unknown as Response;
        });
        const config = parseSmartDecisionConfig({ ...raw, timeout_seconds, fallback })!;
        const pending = selectSmartDecision(config, { systemPrompt: "Test", task: "Test" });
        const checked = fallback ? pending : assert.rejects(pending, /Fallback is disabled/);
        await ready;
        t.mock.timers.tick(config.timeoutSeconds * 1000 - 1);
        assert.equal(requestSignal?.aborted, false);
        t.mock.timers.tick(1);
        assert.equal(await checked, undefined);
        assert.equal(requestSignal?.aborted, true);
        assert.equal(warn.mock.callCount(), fallback ? 1 : 0);
      });
    }
  }
}
