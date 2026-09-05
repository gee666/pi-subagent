import { branchEntries, type ResumableSubagentCall } from "../resume.js";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";
import { isRecord, type ResumeModel, type SessionContext } from "./contracts.js";

export const SUBAGENT_FALLBACK_MODEL_ENV = "PI_SUBAGENT_FALLBACK_MODEL";

export const RESUME_INTERACTIVE_DELAY_MS = 50;

export type SyntheticResumeState = {
  plans: ResumableSubagentCall[];
  phase: "tool" | "final";
  trigger: "resumePrompt" | "nextRequest";
};

export const RESUME_MODEL_DEF = {
  id: RESUME_MODEL_ID,
  name: "Pi Subagent Resume",
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // Keep this large so Pi's pre-prompt auto-compaction does not invoke the
  // synthetic provider before the visible resume prompt is appended. That would
  // consume the tool-call phase during compaction and the real resume turn
  // would only see the final text message.
  contextWindow: 1_000_000,
  maxTokens: 16,
};

export function getMessageText(message: unknown): string {
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

export function isSyntheticResumePrompt(context: unknown, taskCount: number): boolean {
  const messages = isRecord(context) && Array.isArray(context.messages) ? context.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  return getMessageText(lastUser).trim() === `Resuming ${taskCount} subagents...`;
}

export function formatModelFlag(model: ResumeModel | undefined): string | undefined {
  if (!model?.id || !model?.provider) return undefined;
  return `${model.provider}/${model.id}`;
}

export function findLastNonResumeModel(ctx: SessionContext): ResumeModel | undefined {
  const entries = branchEntries(ctx);

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "model_change") continue;
    const provider = entry.provider;
    const modelId = entry.modelId;
    if (provider === RESUME_PROVIDER) continue;
    if (typeof provider !== "string" || typeof modelId !== "string") continue;
    const model = ctx.modelRegistry?.find?.(provider, modelId);
    if (model) return model;
  }
  return undefined;
}

export function getEnvFallbackModel(ctx: SessionContext): ResumeModel | undefined {
  const raw = process.env[SUBAGENT_FALLBACK_MODEL_ENV];
  if (!raw || !raw.includes("/")) return undefined;
  const [provider, ...idParts] = raw.split("/");
  const id = idParts.join("/");
  if (!provider || !id) return undefined;
  return ctx.modelRegistry?.find?.(provider, id);
}

export function getRestorableModel(ctx: SessionContext): ResumeModel | undefined {
  if (ctx.model?.provider && ctx.model.provider !== RESUME_PROVIDER) return ctx.model;
  return findLastNonResumeModel(ctx) ?? getEnvFallbackModel(ctx);
}

export function selectParentModelForSubagent<T extends { provider?: string }>(
  currentModel: T | undefined,
  modelBeforeSynthetic: T | undefined,
  historicalRealModel: T | undefined,
  lastRestorableModel: T | undefined,
): T | undefined {
  if (currentModel?.provider && currentModel.provider !== RESUME_PROVIDER) {
    return currentModel;
  }
  return modelBeforeSynthetic ?? historicalRealModel ?? lastRestorableModel;
}
