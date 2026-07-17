declare module "@mariozechner/pi-ai" {
  export interface ModelUsage {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: number;
    contextTokens?: number;
  }

  export type Message = any;

  export function createAssistantMessageEventStream(): any;
  export function lazyStream(model: any, setup: () => Promise<any>): any;
  export type AssistantMessageEventStream = any;
  export type ProviderStreams = { stream: (...args: any[]) => any; streamSimple: (...args: any[]) => any };

  // First-class faux provider primitives used by the synthetic resume provider.
  export function createFauxCore(options: any): {
    api: string;
    provider: string;
    models: any[];
    stream: (...args: any[]) => any;
    streamSimple: (...args: any[]) => any;
    getModel: (id?: string) => any;
    state: { callCount: number };
    setResponses: (responses: any[]) => void;
    appendResponses: (responses: any[]) => void;
    getPendingResponseCount: () => number;
  };
  export function fauxAssistantMessage(content: any, options?: any): any;
  export function fauxToolCall(name: string, args: any, options?: { id?: string }): any;
  export function fauxText(text: string): any;
}

declare module "@mariozechner/pi-ai/api/openai-responses.lazy" {
  export const openAIResponsesApi: () => any;
}
declare module "@mariozechner/pi-ai/api/openai-completions.lazy" {
  export const openAICompletionsApi: () => any;
}
declare module "@mariozechner/pi-ai/api/azure-openai-responses.lazy" {
  export const azureOpenAIResponsesApi: () => any;
}
declare module "@mariozechner/pi-ai/api/openai-codex-responses.lazy" {
  export const openAICodexResponsesApi: () => any;
}
declare module "@mariozechner/pi-ai/api/anthropic-messages.lazy" {
  export const anthropicMessagesApi: () => any;
}
declare module "@mariozechner/pi-ai/api/bedrock-converse-stream.lazy" {
  export const bedrockConverseStreamApi: () => any;
}
declare module "@mariozechner/pi-ai/api/google-generative-ai.lazy" {
  export const googleGenerativeAIApi: () => any;
}
declare module "@mariozechner/pi-ai/api/google-vertex.lazy" {
  export const googleVertexApi: () => any;
}
declare module "@mariozechner/pi-ai/api/mistral-conversations.lazy" {
  export const mistralConversationsApi: () => any;
}
declare module "@mariozechner/pi-ai/api/pi-messages.lazy" {
  export const piMessagesApi: () => any;
}

declare module "@mariozechner/pi-agent-core" {
  export interface AgentToolResult<TDetails = unknown> {
    content: Array<{ type: string; text?: string }>;
    details?: TDetails;
    isError?: boolean;
  }
}

declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionContext {
    cwd: string;
    model?: any;
    hasUI?: boolean;
    ui?: any;
    sessionManager: {
      getEntries: () => any[];
      getSessionDir: () => string | undefined;
      getLeafId: () => string | undefined;
      getBranch: (leafId: string) => any[] | undefined;
    };
  }

  export interface ExtensionAPI {
    registerFlag(name: string, config: any): void;
    getFlag(name: string): unknown;
    registerProvider(name: string, provider: any): void;
    registerTool(tool: any): void;
    addBeforeAgentStart(hook: (ctx: ExtensionContext) => unknown): void;
    addBeforeRequest(hook: (event: any, ctx: any) => unknown): void;
    addAfterMessage(hook: (event: any, ctx: any) => unknown): void;
    setModel(model: any): Promise<boolean> | boolean;
    [key: string]: any;
  }

  export function getAgentDir(): string;
  export function parseFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string };
}

declare module "@mariozechner/pi-tui" {
  export class Text {
    constructor(text: string, x?: number, y?: number);
  }
  export class Spacer {
    constructor(size?: number);
  }
  export class Container {
    addChild(child: unknown): void;
  }
}

declare module "express" {
  export interface Request {
    method: string;
    path: string;
  }
  export interface Response {
    statusCode: number;
    on(event: "finish", listener: () => void): void;
  }
  export type NextFunction = () => void;
}
