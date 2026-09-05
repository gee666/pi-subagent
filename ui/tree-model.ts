import type { LiveLogEntry } from "../types.js";
export type NodeStatus = "running" | "success" | "error";

export interface TreeNode {
  label: string;
  status: NodeStatus;
  meta?: string;
  task?: string;
  startedAt?: number;
  lastActionAt?: number;
  outputPreview?: string[];
  liveActivity?: LiveLogEntry[];
  children: TreeNode[];
}

export interface TreeCounts {
  total: number;
  running: number;
  success: number;
  error: number;
  finished: number;
}
