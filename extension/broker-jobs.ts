import { BROKER_DIR_ENV, BROKER_SECRET_ENV, type BrokerEndpoint, type BrokerJobSpec } from "../broker/contracts.js";
import { ackBrokerJob, listBrokerJobs, watchBrokerJob } from "../broker/files.js";
import { steerBrokerJob } from "../broker/commands.js";
import { WORKER_TOKEN_ENV } from "../runner/tree-admission.js";
import { branchEntries } from "../resume.js";
import { buildSubagentDetails, DEFAULT_DELEGATION_MODE } from "../types.js";
import { startBackground, notifyLead } from "./async-jobs.js";
import { publishCompletion } from "./completion.js";
import type { SessionContext } from "./contracts.js";
import type { ExtensionState } from "./state.js";

export const BROKER_CONSUMED_ENTRY = "pi-subagent-broker-consumed";
const watches = new WeakMap<ExtensionState, Set<AbortController>>();
export function inheritedBrokerEndpoint(): BrokerEndpoint | undefined {
  const directory = process.env[BROKER_DIR_ENV],
    secret = process.env[BROKER_SECRET_ENV];
  if (!directory && !secret) return undefined;
  if (!directory || !secret) throw new Error("Incomplete root broker metadata. No nested workers were launched.");
  return { directory, secret };
}
export function detachBrokerJobs(state: ExtensionState): void {
  for (const controller of watches.get(state) ?? []) controller.abort(new Error("Broker watch detached for parking."));
  watches.delete(state);
  state.backgroundJobs.clear();
}
export async function watchOwnedBrokerJob(
  state: ExtensionState,
  endpoint: BrokerEndpoint,
  spec: BrokerJobSpec,
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  let controllers = watches.get(state);
  if (!controllers) watches.set(state, (controllers = new Set()));
  controllers.add(controller);
  try {
    return await watchBrokerJob(
      endpoint,
      spec.id,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      (message) => notifyLead(state, `Message from subagent ${spec.name}:\n${message}`),
    );
  } finally {
    controllers.delete(controller);
  }
}
export function brokerProxyHandle(endpoint: BrokerEndpoint, spec: BrokerJobSpec) {
  return { steer: (message: string) => steerBrokerJob(endpoint, spec.ownerToken, spec.token, message) };
}
function consumedIds(ctx: SessionContext): Set<string> {
  const consumed = new Set<string>();
  for (const entry of branchEntries(ctx)) {
    if (entry.type === "message" && entry.message.role === "custom") {
      const details = entry.message.details;
      if (details && typeof details === "object" && "brokerJobId" in details && typeof details.brokerJobId === "string")
        consumed.add(details.brokerJobId);
    }
  }
  return consumed;
}

/** Restore durable child watches before synthetic crash recovery can duplicate their launches. */
export async function restoreBrokerJobs(state: ExtensionState, ctx: SessionContext): Promise<boolean> {
  if (state.currentDepth === 0) return false;
  const endpoint = inheritedBrokerEndpoint(),
    ownerToken = process.env[WORKER_TOKEN_ENV];
  if (!endpoint || !ownerToken) return false;
  // A consumption marker/file ACK can precede persistence of its actual context
  // message. Completed result files remain available, so replay if that message is absent.
  const jobs = listBrokerJobs(endpoint).filter((spec) => spec.ownerToken === ownerToken);
  const consumed = consumedIds(ctx);
  let restored = false;
  for (const spec of jobs) {
    if (consumed.has(spec.id)) {
      ackBrokerJob(endpoint, spec.id);
      continue;
    }
    restored = true;
    const key = `broker:${spec.id}`;
    if (state.backgroundJobs.has(key)) continue;
    const generation = state.lifecycleGeneration;
    const id = state.nextActiveSubagentId++;
    state.activeSubagents.set(id, {
      name: spec.name,
      agent: spec.task.agent,
      task: spec.task.task,
      handle: brokerProxyHandle(endpoint, spec),
    });
    if (spec.resumeSession) state.activeResumeNames.add(spec.name);
    startBackground(
      state,
      key,
      [spec.name],
      async (signal) => {
        const result = await watchOwnedBrokerJob(state, endpoint, spec, signal);
        publishCompletion(state, result, generation, { jobId: spec.toolCallId, taskIndex: spec.taskIndex }, spec.id);
        return {
          content: [{ type: "text", text: result.finalOutput ?? "" }],
          details: buildSubagentDetails("single", DEFAULT_DELEGATION_MODE, null, [result]),
        };
      },
      async () => {
        if (generation !== state.lifecycleGeneration) return;
        state.activeSubagents.delete(id);
        state.activeResumeNames.delete(spec.name);
      },
    );
  }
  return restored;
}
