import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentDetails } from "../types.js";

export type ResumeModel = NonNullable<ExtensionContext["model"]>;
export type ResumeModelRegistry = ExtensionContext["modelRegistry"];
export type SessionContext = ExtensionContext;
export type StreamOptions = SimpleStreamOptions;
export type ProviderContext = Context;
export type ProgressUpdate = AgentToolResult<SubagentDetails>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
