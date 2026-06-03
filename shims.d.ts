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
  export function streamSimple(model: any, context: any, options: any): any;
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
