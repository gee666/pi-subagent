import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { runAgentSubprocess } from "../runner.js";
import { TreeWorkerAdmission } from "../runner/tree-admission.js";
import type { RunningSubagentHandle } from "../runner/options.js";
import type { TreeConcurrencyStore } from "../storage/tree-concurrency.js";
import { processIdentity } from "../storage/tree-concurrency-process.js";
import { withSessionSettings } from "../settings.js";
import { buildSubagentDetails, emptyUsage, type SingleResult } from "../types.js";
import { listBrokerJobs, persistBrokerResult, writeExclusive } from "./files.js";
import type { BrokerEndpoint, BrokerJobSpec } from "./contracts.js";
import { processBrokerCommands } from "./commands.js";

interface RootBroker {
  endpoint: BrokerEndpoint;
  store: TreeConcurrencyStore;
  active: Map<string, AbortController>;
  jobs: Map<string, Promise<void>>;
  handles: Map<string, RunningSubagentHandle>;
  lineage: Map<string, { name: string; parentToken?: string }>;
  nested: Set<string>;
  activity: Map<string, { startedAt: number; idle: boolean }>;
  poll?: ReturnType<typeof setTimeout>;
  closed: boolean;
}
const roots = new Map<string, RootBroker>();

export function registerBrokerHandle(endpoint: BrokerEndpoint, token: string, handle?: RunningSubagentHandle): void {
  const root = roots.get(endpoint.directory);
  if (!root || root.closed) return;
  if (handle) {
    const entry = root.store.get(token);
    if (entry) root.lineage.set(token, { name: entry.name, parentToken: entry.parentToken });
    if (entry?.parentToken) root.nested.add(token);
    root.handles.set(token, handle);
    root.activity.set(token, { startedAt: Date.now(), idle: false });
  } else {
    root.handles.delete(token);
    root.activity.delete(token);
  }
}

/** UI-only view. All filesystem and ledger reads happen on registration/control paths. */
export function brokerActivity(
  endpoint: BrokerEndpoint,
): Array<{ name: string; path: string[]; startedAt: number; idle: boolean }> {
  const root = roots.get(endpoint.directory);
  if (!root || root.closed) return [];
  return [...root.activity].flatMap(([token, activity]) => {
    if (!root.nested.has(token)) return [];
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = token;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = root.lineage.get(cursor);
      if (!node) break;
      names.unshift(node.name);
      cursor = node.parentToken;
    }
    return [{ name: names.at(-1) ?? "worker", path: names, ...activity }];
  });
}
export function brokerHandle(endpoint: BrokerEndpoint, token: string): RunningSubagentHandle | undefined {
  return roots.get(endpoint.directory)?.handles.get(token);
}
function failed(spec: BrokerJobSpec, error: unknown): SingleResult {
  return {
    ...(spec.initialResult ?? {}),
    agent: spec.task.agent,
    agentSource: "unknown",
    task: spec.task.task,
    name: spec.name,
    submittedAt: spec.submittedAt,
    budget: spec.budget,
    sessionDir: spec.sessionDir,
    exitCode: 130,
    messages: [],
    stderr: "",
    usage: spec.initialResult?.usage ?? emptyUsage(),
    toolCalls: spec.initialResult?.toolCalls ?? {},
    completedTurns: spec.initialResult?.completedTurns ?? 0,
    turnInProgress: false,
    liveLog: [],
    stopReason: "aborted",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}
async function execute(root: RootBroker, spec: BrokerJobSpec, controller: AbortController): Promise<void> {
  try {
    root.nested.add(spec.token);
    root.lineage.set(spec.token, { name: spec.name, parentToken: spec.ownerToken });
    root.store.adopt(spec.token);
    const admission = TreeWorkerAdmission.adopt(root.store, spec.token, root.endpoint);
    const result = await runAgentSubprocess({
      treeAdmission: admission,
      cwd: spec.cwd,
      settings: spec.settings ? withSessionSettings(spec.settings, spec.settings) : undefined,
      projectTrusted: spec.projectTrusted,
      agents: spec.agents,
      agentName: spec.task.agent,
      task: spec.task.task,
      subagentName: spec.name,
      budget: spec.budget,
      parentDepth: spec.parentDepth,
      parentAgentStack: spec.parentAgentStack,
      maxDepth: spec.maxDepth,
      preventCycles: spec.preventCycles,
      signal: controller.signal,
      sessionDir: spec.sessionDir,
      sessionRoot: spec.sessionRoot,
      namesFile: spec.namesFile,
      resumeSession: spec.resumeSession,
      initialResult: spec.initialResult,
      fallbackModel: spec.fallbackModel,
      resumeSettings: spec.resumeSettings,
      intelligence: spec.task.intelligence,
      intelligencePresets: spec.intelligencePresets,
      rawPrompt: spec.resumeSession,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
      onHandle: (handle) => registerBrokerHandle(root.endpoint, spec.token, handle),
      onWaitingForChildren: (waiting) => {
        const activity = root.activity.get(spec.token);
        if (activity) activity.idle = waiting;
      },
      onLeadMessage: (message) => {
        const parent = root.store.get(spec.ownerToken);
        if (parent?.status === "running" && parent.pid && root.store.isProcessAlive(parent)) {
          writeExclusive(path.join(root.endpoint.directory, "leads", spec.id, `${randomUUID()}.json`), {
            ownerPid: parent.pid,
            message,
          });
        }
      },
    });
    if (spec.submittedAt !== undefined) result.submittedAt = spec.submittedAt;
    if (!root.closed) persistBrokerResult(root.endpoint, spec.id, result);
  } catch (error) {
    if (!root.closed) persistBrokerResult(root.endpoint, spec.id, failed(spec, error));
  } finally {
    root.handles.delete(spec.token);
    root.activity.delete(spec.token);
    root.nested.delete(spec.token);
    root.active.delete(spec.id);
    if (!root.closed && root.store.get(spec.ownerToken)?.status === "suspended")
      root.store.requestWake(spec.ownerToken);
  }
}
function poll(root: RootBroker): void {
  if (root.closed) return;
  try {
    processBrokerCommands(root.endpoint, root.store, root.handles);
    for (const spec of listBrokerJobs(root.endpoint, true)) {
      if (root.active.has(spec.id)) continue;
      const entry = root.store.get(spec.token);
      if (!entry || entry.name !== spec.name || entry.parentToken !== spec.ownerToken)
        throw new Error("Broker job does not match its global reservation.");
      const controller = new AbortController();
      root.active.set(spec.id, controller);
      const execution = execute(root, spec, controller);
      root.jobs.set(spec.id, execution);
      void execution
        .catch((error) => {
          console.error("[pi-subagent] Root broker job failed:", error);
        })
        .finally(() => root.jobs.delete(spec.id));
    }
  } catch (error) {
    // Never spawn from an unreadable mailbox. Retain reservations and fail closed.
    console.error("[pi-subagent] Root broker polling blocked:", error);
  }
  if (!root.closed) {
    root.poll = setTimeout(() => poll(root), 25);
    root.poll.unref();
  }
}

/** Construct directly from the tree store. This does not call extension schedulerFor. */
export function createRootBroker(store: TreeConcurrencyStore): BrokerEndpoint {
  const directory = path.join(store.directory, "broker");
  const previous = roots.get(directory);
  if (previous && !previous.closed) return previous.endpoint;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  const endpoint = { directory, secret };
  fs.writeFileSync(path.join(directory, "secret"), secret, { flag: "wx", mode: 0o600 });
  const identity = processIdentity(process.pid);
  writeExclusive(path.join(directory, "manifest.json"), {
    version: 1,
    rootPid: process.pid,
    rootStartTime: identity.startTime,
    concurrencyDirectory: store.directory,
  });
  const root: RootBroker = {
    endpoint,
    store,
    active: new Map(),
    jobs: new Map(),
    handles: new Map(),
    lineage: new Map(),
    nested: new Set(),
    activity: new Map(),
    closed: false,
  };
  roots.set(directory, root);
  // The endpoint exists before any worker spawn; adoption itself begins on the next turn.
  root.poll = setTimeout(() => poll(root), 0);
  root.poll.unref();
  return endpoint;
}
export async function shutdownRootBroker(endpoint: BrokerEndpoint): Promise<void> {
  const root = roots.get(endpoint.directory);
  if (!root) return;
  root.closed = true;
  if (root.poll) clearTimeout(root.poll);
  for (const controller of root.active.values()) controller.abort();
  for (const handle of root.handles.values()) handle.kill?.();
  await Promise.allSettled(root.jobs.values());
  roots.delete(endpoint.directory);
}
