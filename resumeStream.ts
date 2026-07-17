/**
 * Durable model-streaming helper for the synthetic subagent-resume provider.
 *
 * The synthetic resume provider only ever synthesizes an assistant turn that
 * carries the `subagent` tool call(s). But pi may still invoke the provider's
 * `streamSimple` handler in edge/race situations where the real model has not
 * been restored yet (e.g. a request arrives before `pi.setModel(realModel)`
 * has propagated). In that case the handler must forward the request to the
 * real fallback model and return a valid assistant stream.
 *
 * Historically this used the global `streamSimple` dispatcher exported from the
 * `@mariozechner/pi-ai` package root. Pi's provider/model rework moved that
 * dispatcher into the explicitly temporary `@mariozechner/pi-ai/compat`
 * entrypoint ("deleted with the coding-agent ModelManager migration").
 *
 * This module reimplements the same behavior using only stable pi-ai exports:
 *   - the root `lazyStream` helper (returns a stream synchronously while async
 *     setup runs behind it), and
 *   - the per-API `ProviderStreams` factories published under the stable
 *     `@mariozechner/pi-ai/api/*` subpaths.
 *
 * `model.api` selects the concrete API implementation, mirroring exactly what
 * pi core does when it dispatches a stream to the provider that owns a model.
 */
import { lazyStream } from "@mariozechner/pi-ai";
import type { AssistantMessageEventStream, ProviderStreams } from "@mariozechner/pi-ai";

type ProviderStreamsFactory = () => ProviderStreams;

/**
 * Lazily import the `ProviderStreams` factory for a given `model.api`.
 *
 * Each entry maps a `KnownApi` id to its stable `/api/*` subpath module and the
 * factory export that module provides. Dynamic `import()` keeps the API modules
 * out of the hot path until a fallback stream is actually needed, and the
 * host's module cache deduplicates repeated loads.
 */
const API_LOADERS: Record<string, () => Promise<ProviderStreamsFactory>> = {
  "openai-responses": async () =>
    (await import("@mariozechner/pi-ai/api/openai-responses.lazy")).openAIResponsesApi,
  "openai-completions": async () =>
    (await import("@mariozechner/pi-ai/api/openai-completions.lazy")).openAICompletionsApi,
  "azure-openai-responses": async () =>
    (await import("@mariozechner/pi-ai/api/azure-openai-responses.lazy")).azureOpenAIResponsesApi,
  "openai-codex-responses": async () =>
    (await import("@mariozechner/pi-ai/api/openai-codex-responses.lazy")).openAICodexResponsesApi,
  "anthropic-messages": async () =>
    (await import("@mariozechner/pi-ai/api/anthropic-messages.lazy")).anthropicMessagesApi,
  "bedrock-converse-stream": async () =>
    (await import("@mariozechner/pi-ai/api/bedrock-converse-stream.lazy")).bedrockConverseStreamApi,
  "google-generative-ai": async () =>
    (await import("@mariozechner/pi-ai/api/google-generative-ai.lazy")).googleGenerativeAIApi,
  "google-vertex": async () =>
    (await import("@mariozechner/pi-ai/api/google-vertex.lazy")).googleVertexApi,
  "mistral-conversations": async () =>
    (await import("@mariozechner/pi-ai/api/mistral-conversations.lazy")).mistralConversationsApi,
  "pi-messages": async () =>
    (await import("@mariozechner/pi-ai/api/pi-messages.lazy")).piMessagesApi,
};

const providerStreamsCache = new Map<string, ProviderStreams>();

/** API ids for which the resume fallback can forward to a real model. */
export function getSupportedResumeFallbackApis(): string[] {
  return Object.keys(API_LOADERS);
}

/** Load (and cache) the `ProviderStreams` implementation for a `model.api`. */
export async function resolveProviderStreams(api: string): Promise<ProviderStreams> {
  const cached = providerStreamsCache.get(api);
  if (cached) return cached;

  const loader = API_LOADERS[api];
  if (!loader) {
    throw new Error(
      `Subagent resume cannot forward to fallback model: unsupported model API "${api}". ` +
        `Supported APIs: ${Object.keys(API_LOADERS).join(", ")}.`,
    );
  }

  const factory = await loader();
  const providerStreams = factory();
  providerStreamsCache.set(api, providerStreams);
  return providerStreams;
}

/**
 * Stream a real fallback model through its owning API implementation.
 *
 * Returns synchronously via `lazyStream`; the async API-module load and the
 * underlying provider request run behind the returned stream. `options` is
 * expected to already carry the resolved `apiKey`/`headers` (the extension
 * resolves those through `ctx.modelRegistry.getApiKeyAndHeaders`).
 */
export function streamSimpleForModel(
  model: any,
  context: any,
  options: any,
): AssistantMessageEventStream {
  return lazyStream(model, async () => {
    const providerStreams = await resolveProviderStreams(model.api);
    return providerStreams.streamSimple(model, context, options);
  });
}
