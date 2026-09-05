import { createFauxCore, createProvider, fauxAssistantMessage, fauxToolCall, lazyStream } from "@earendil-works/pi-ai";
import { findLatestResumableSubagentCalls } from "../resume.js";
import { RESUME_PROVIDER } from "../shared.js";
import { SUBAGENT_TOOL_NAME } from "../types.js";
import type { ResumeModel, StreamOptions, ProviderContext } from "./contracts.js";
import { RESUME_MODEL_DEF, isSyntheticResumePrompt } from "./models.js";
import { restoreVisibleModelForResume } from "./runtime.js";
import type { ExtensionState } from "./state.js";

export function mergeProviderHeaders(
  base: Record<string, string | null> | undefined,
  override: Record<string, string | null> | undefined,
): Record<string, string | null> | undefined {
  const merged = new Map<string, [string, string | null]>();
  for (const headers of [base, override]) {
    for (const [name, value] of Object.entries(headers ?? {})) {
      const key = name.toLowerCase();
      if (value === null) merged.delete(key);
      else merged.set(key, [name, value]);
    }
  }
  return merged.size > 0 ? Object.fromEntries(merged.values()) : undefined;
}

export function streamWithRealModelFallback(
  state: ExtensionState,
  context: ProviderContext,
  options: StreamOptions | undefined,
  fallback: ResumeModel | undefined,
  expectedGeneration = state.lifecycleGeneration,
) {
  if (!fallback || !state.resumeModelRegistry) return null;

  // Use pi 0.81's effective Provider instead of dispatching on model.api.
  // This preserves custom provider streams, provider composition, dynamic
  // auth base URLs, provider-scoped env, and future/custom API identifiers.
  const registry = state.resumeModelRegistry;
  return lazyStream(fallback, async () => {
    if (!state.sessionActive || expectedGeneration !== state.lifecycleGeneration) {
      throw new Error("Subagent resume fallback was cancelled by session replacement.");
    }
    const provider = registry.getProvider?.(fallback.provider);
    if (!provider || provider.id === RESUME_PROVIDER) {
      throw new Error(`Subagent resume fallback provider is unavailable: ${fallback.provider}.`);
    }
    const [providerResolution, modelResolution] = await Promise.all([
      registry.getProviderAuth?.(fallback.provider),
      registry.getApiKeyAndHeaders?.(fallback),
    ]);
    if (!state.sessionActive || expectedGeneration !== state.lifecycleGeneration) {
      throw new Error("Subagent resume fallback was cancelled by session replacement.");
    }
    if (!providerResolution || !modelResolution?.ok) {
      throw new Error(
        modelResolution && !modelResolution.ok
          ? modelResolution.error
          : `Provider is not configured: ${fallback.provider}`,
      );
    }
    const providerAuth = providerResolution.auth ?? {};
    const requestModel = providerAuth.baseUrl ? { ...fallback, baseUrl: providerAuth.baseUrl } : fallback;
    const requestOptions = {
      ...options,
      // Model-aware resolution includes configured/model headers. Never
      // forward the synthetic provider's no-op credential.
      apiKey: modelResolution.apiKey,
      headers: mergeProviderHeaders(modelResolution.headers, options?.headers),
      env: {
        ...(providerResolution.env ?? {}),
        ...(modelResolution.env ?? {}),
        ...(options?.env ?? {}),
      },
    };
    return provider.streamSimple(requestModel, context, requestOptions);
  });
}

export function registerResumeProvider(state: ExtensionState): void {
  const resumeCore = createFauxCore({
    api: "openai-responses",
    provider: RESUME_PROVIDER,
    models: [RESUME_MODEL_DEF],
  });

  const resumeProvider = createProvider({
    id: RESUME_PROVIDER,
    name: "Pi Subagent Resume",
    auth: {
      apiKey: {
        name: "Internal synthetic resume provider",
        async resolve() {
          return {
            auth: { apiKey: "pi-subagent-resume-noop-key" },
            source: "internal synthetic provider",
          };
        },
      },
    },
    models: resumeCore.models,
    api: {
      stream: resumeCore.stream,
      streamSimple: (model, context, options) => {
        const resume = state.resumeState;
        const expectedGeneration = state.lifecycleGeneration;
        const discoveredPlans =
          resume.plans.length > 0
            ? resume.plans
            : state.pendingResumePlans.length > 0
              ? state.pendingResumePlans
              : state.latestSessionCtx
                ? findLatestResumableSubagentCalls(state.latestSessionCtx)
                : [];
        if (discoveredPlans.length > 0 && resume.plans.length === 0) {
          resume.plans = [...discoveredPlans];
          state.pendingResumePlans = [...discoveredPlans];
        }
        const plans = discoveredPlans;
        const totalTaskCount = plans.reduce((sum, plan) => sum + plan.tasks.length, 0);
        const phase = resume.phase;
        const triggerMatches =
          resume.trigger === "nextRequest" ||
          (totalTaskCount > 0 ? isSyntheticResumePrompt(context, totalTaskCount) : false);

        // Happy path: emit the resumed subagent tool call(s) as one canned
        // assistant turn. The faux core streams the message we build with
        // `fauxToolCall`/`fauxAssistantMessage` as proper stream events.
        if (plans.length > 0 && phase === "tool" && triggerMatches) {
          resume.phase = "final";
          const toolCalls = plans.map((plan, index) =>
            fauxToolCall(SUBAGENT_TOOL_NAME, { tasks: plan.tasks }, { id: `resume_subagent_${Date.now()}_${index}` }),
          );
          resumeCore.setResponses([() => fauxAssistantMessage(toolCalls, { stopReason: "toolUse" })]);
          const stream = resumeCore.streamSimple(model, context, options);
          // Restore the real model once the injected turn has fully streamed so
          // the TUI does not appear stuck on `pi-subagent-resume` while the
          // subagent tool execution is still running.
          void stream
            .result()
            .catch(() => {})
            .finally(() => {
              void restoreVisibleModelForResume(state, expectedGeneration);
            });
          return stream;
        }

        const fallback = streamWithRealModelFallback(
          state,
          context,
          options,
          state.modelToRestoreAfterResume ?? state.lastRestorableModel,
          expectedGeneration,
        );
        if (fallback) {
          void restoreVisibleModelForResume(state, expectedGeneration);
          return fallback;
        }

        // No real model to fall back to: surface a clear error turn.
        if (!(plans.length > 0 && phase === "tool")) {
          resume.plans = [];
          resume.phase = "tool";
        }
        const errorText = "Subagent resume failed: synthetic resume provider was invoked without a valid resume plan.";
        resumeCore.setResponses([() => fauxAssistantMessage([], { stopReason: "error", errorMessage: errorText })]);
        return resumeCore.streamSimple(model, context, options);
      },
    },
  });

  state.pi.registerProvider(resumeProvider);
}
