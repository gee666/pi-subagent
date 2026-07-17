/**
 * Guards the durable fallback-streaming dispatcher used by the synthetic
 * subagent-resume provider.
 *
 * The synthetic provider must be able to forward a request to the real
 * fallback model without depending on the deprecated/temporary
 * `@mariozechner/pi-ai/compat` global `streamSimple`. Instead it dispatches on
 * `model.api` to pi-ai's stable per-API `ProviderStreams` factories.
 *
 * These tests fail loudly if a future pi release renames or moves those stable
 * `/api/*` subpath exports, or drops a `KnownApi` we advertise support for.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  getSupportedResumeFallbackApis,
  resolveProviderStreams,
  streamSimpleForModel,
} from "../resumeStream.js";

describe("resume fallback stream dispatcher", () => {
  test("every advertised API resolves to a real ProviderStreams implementation", async () => {
    const apis = getSupportedResumeFallbackApis();
    assert.ok(apis.length > 0, "expected at least one supported fallback API");

    for (const api of apis) {
      const providerStreams = await resolveProviderStreams(api);
      assert.equal(
        typeof providerStreams.streamSimple,
        "function",
        `ProviderStreams for "${api}" must expose streamSimple()`,
      );
      assert.equal(
        typeof providerStreams.stream,
        "function",
        `ProviderStreams for "${api}" must expose stream()`,
      );
    }
  });

  test("covers the KnownApi surface pi ships today", () => {
    // If pi adds a new KnownApi, extend API_LOADERS so resume can forward to
    // models on that API too. This list mirrors pi-ai's KnownApi union.
    const knownApis = [
      "openai-completions",
      "mistral-conversations",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "bedrock-converse-stream",
      "google-generative-ai",
      "google-vertex",
      "pi-messages",
    ];
    const supported = new Set(getSupportedResumeFallbackApis());
    const missing = knownApis.filter((api) => !supported.has(api));
    assert.deepEqual(missing, [], `unsupported KnownApi values: ${missing.join(", ")}`);
  });

  test("unsupported model API surfaces a clear stream error instead of throwing", async () => {
    const model = { id: "x", provider: "x", api: "totally-unknown-api" };
    const stream = streamSimpleForModel(model, { messages: [] }, {});

    let errored = false;
    for await (const event of stream) {
      if (event?.type === "error") {
        errored = true;
        const text = event.error?.errorMessage ?? "";
        assert.match(text, /unsupported model API "totally-unknown-api"/);
      }
    }
    assert.ok(errored, "expected an error event for an unsupported API");
  });
});
