export interface DetailChildRef {
  name?: string;
  agent: string;
  status: "running" | "success" | "error";
  task: string;
}

export type DetailEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string; assistantTurn?: number }
  | { type: "tool"; name: string; preview: string; arguments: string; isError?: boolean; result?: string }
  | { type: "children"; toolName: string; children: DetailChildRef[] };

export interface DetailBlock {
  kind: "task" | "resume";
  index: number;
  prompt: string;
  at?: number;
  events: DetailEvent[];
}

export interface DetailUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface SubagentDetail {
  name: string;
  agent: string;
  model?: string;
  tools?: string[];
  createdAt?: number;
  sessionDir: string;
  sessionFile?: string;
  forkCount: number;
  blocks: DetailBlock[];
  usage: DetailUsage;
  toolCallCount: number;
  notes: string[];
}
