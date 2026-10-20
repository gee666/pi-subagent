import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { readNamesRegistry } from "../names.js";
import { renderResult } from "../render.js";
import { killPidTreeImmediately } from "../runner/launch.js";
import { markStoppedNames } from "../storage/stopped-workers.js";
import { buildSubagentDetails, DEFAULT_DELEGATION_MODE, STOP_SUBAGENT_TOOL_NAME } from "../types.js";
import { validatePreparedArguments } from "./schemas.js";
import { schedulerFor } from "./scheduler.js";
import type { ExtensionState } from "./state.js";
import { assertDirectChild } from "./child-ownership.js";

const Name = Type.String({ minLength: 1, pattern: "\\S" });
export const StopSubagentParams = Type.Object(
  {
    name: Type.Union([Name, Type.Array(Name, { minItems: 1 })], {
      description:
        "One worker name or an array of names. Each target and all its running or queued descendants are stopped.",
    }),
  },
  { additionalProperties: false },
);

export interface StopSubagentStatus {
  name: string;
  status: "stopped" | "canceled" | "idle" | "unknown" | "error";
  error?: string;
}

const statusText = {
  stopped: "Stopped running subagent immediately.",
  canceled: "Canceled queued or suspended work.",
  idle: "Already idle; no running or queued work.",
  unknown: "Unknown subagent name.",
  error: "Could not stop subagent.",
};

/** Tombstone the entire branch before signaling any process, including remote descendants. */
function stopBranches(
  state: ExtensionState,
  names: string[],
): { statuses: StopSubagentStatus[]; stoppedNames: string[] } {
  const scheduler = schedulerFor(state);
  const store = scheduler.treeStore;
  const before = new Map(store?.snapshot().map((entry) => [entry.token, entry]) ?? []);
  const affected = names.flatMap((name) => store?.stopSubtree(name) ?? []);
  const statuses = new Map<string, StopSubagentStatus>();
  for (const entry of affected) {
    const prior = before.get(entry.token);
    if (prior && !["queued", "running", "parking", "suspended", "waking", "stopping"].includes(prior.status)) continue;
    if (entry.status !== "stopping" && entry.status !== "canceled") continue;
    const status = entry.status === "stopping" ? "stopped" : "canceled";
    if (statuses.get(entry.name)?.status !== "stopped") statuses.set(entry.name, { name: entry.name, status });
    if (store?.isProcessAlive(entry) && entry.pid) killPidTreeImmediately(entry.pid);
  }
  // Local handles also cover callers using the standalone runner without a tree ledger.
  for (const name of new Set([...names, ...statuses.keys()])) {
    try {
      let running = false;
      for (const worker of state.activeSubagents.values()) {
        if (worker.name !== name) continue;
        running = true;
        worker.handle.kill?.();
      }
      const previous = scheduler.stop(name);
      if (running || previous === "started" || previous === "stopping") statuses.set(name, { name, status: "stopped" });
      else if (previous === "queued" && !statuses.has(name)) statuses.set(name, { name, status: "canceled" });
      if (statuses.has(name)) continue;
      const known = state.currentNamesFile && Object.hasOwn(readNamesRegistry(state.currentNamesFile).agents, name);
      statuses.set(name, { name, status: known ? "idle" : "unknown" });
    } catch (error) {
      statuses.set(name, { name, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  const order = [...new Set([...names, ...statuses.keys()])];
  return {
    statuses: order.map((name) => statuses.get(name)!),
    stoppedNames: [
      ...new Set([
        ...affected.map((entry) => entry.name),
        ...[...statuses.values()]
          .filter(({ status }) => status === "stopped" || status === "canceled")
          .map(({ name }) => name),
      ]),
    ],
  };
}

export function registerStopSubagentTool(state: ExtensionState): void {
  state.pi.registerTool({
    name: STOP_SUBAGENT_TOOL_NAME,
    label: "Stop subagent",
    description:
      state.configuredToolPrompts[STOP_SUBAGENT_TOOL_NAME] ??
      "Immediately kill named workers and all their descendants, including detached processes, queued tasks and queued resumes at every depth. name accepts one name or an array of names, but only your own direct children may be targeted. Requests targeting grandchildren, siblings or another agent's workers return an error. Stopping a direct child still stops its entire subtree. Other branches keep running. Stops do not refund spent or reserved budget. Reports stopped, canceled, idle, or unknown for each requested name and affected descendant. A later explicit message_subagent can resume a stopped worker with a saved session.",
    parameters: StopSubagentParams,
    prepareArguments: (args) => validatePreparedArguments(StopSubagentParams, args),
    async execute(toolCallId, rawParams, signal) {
      const details = () => buildSubagentDetails("parallel", DEFAULT_DELEGATION_MODE, null, []);
      try {
        const { name } = validatePreparedArguments(StopSubagentParams, rawParams);
        signal?.throwIfAborted();
        if (!state.sessionActive) throw new Error("Cannot stop subagents: no active session.");
        const names = [...new Set(typeof name === "string" ? [name] : name)];
        const denied = new Map<string, StopSubagentStatus>();
        const allowed = names.filter((name) => {
          try {
            assertDirectChild(state, name);
            return true;
          } catch (error) {
            denied.set(name, { name, status: "error", error: error instanceof Error ? error.message : String(error) });
            return false;
          }
        });
        const stopped = allowed.length ? stopBranches(state, allowed) : { statuses: [], stoppedNames: [] };
        const combined = new Map(stopped.statuses.map((status) => [status.name, status]));
        for (const [name, status] of denied) combined.set(name, status);
        const statuses = [...new Set([...names, ...combined.keys()])].map((name) => combined.get(name)!);
        const stoppedNames = stopped.stoppedNames;
        let warning: string | undefined;
        try {
          await markStoppedNames(state.currentNamesFile, stoppedNames);
        } catch (error) {
          warning = `Workers were stopped, but saving recovery stop markers failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        const isError = !!warning || statuses.some(({ status }) => status === "unknown" || status === "error");
        if (isError) state.forcedErrorToolCallIds.add(toolCallId);
        return {
          content: [
            {
              type: "text",
              text: [
                ...statuses.map(({ name, status, error }) => `${name}: ${error ?? statusText[status]}`),
                ...(warning ? [warning] : []),
              ].join("\n"),
            },
          ],
          details: Object.assign(details(), { statuses, stoppedNames }, warning ? { warning } : {}),
          ...(isError ? { isError: true } : {}),
        };
      } catch (error) {
        state.forcedErrorToolCallIds.add(toolCallId);
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: details(),
          isError: true,
        };
      }
    },
    renderCall(args, theme) {
      const names = typeof args.name === "string" ? [args.name] : Array.isArray(args.name) ? args.name : [];
      return new Text(
        `${theme.fg("toolTitle", theme.bold("stop subagent "))}${theme.fg("accent", [...new Set(names)].join(", "))}`,
        0,
        0,
      );
    },
    renderResult: (result, { expanded }, theme, context) => renderResult(result, expanded, theme, context),
  });
}
