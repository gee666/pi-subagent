import { type SingleResult, type SubagentDetails, isSubagentDetails } from "../types.js";
import { nestedBroadcastHistory, updateBroadcastTargetCache } from "./broadcast-history.js";
import type { SessionContext } from "./contracts.js";
import type { ExtensionState } from "./state.js";

export const BROADCAST_STEER_PREFIX = "__PI_SUBAGENT_BROADCAST_STEER__";

export interface BroadcastTarget {
  /** Human-name path, e.g. "John > Maria > Elena". */
  display: string;
  topLevelId: number;
  restPath: string[];
  startedAt?: number;
  idle?: boolean;
}

export interface ParsedBroadcastSelection {
  targets: BroadcastTarget[];
  errors: string[];
}

export function parseBroadcastSelection(input: string, available: BroadcastTarget[]): ParsedBroadcastSelection {
  if (input.trim().toUpperCase() === "ALL") return { targets: [...available], errors: [] };
  const byName = new Map<string, BroadcastTarget>();
  for (const target of available) {
    byName.set(target.display.toLowerCase(), target);
    // Names are globally unique across the delegation tree, so a nested leaf
    // can be addressed as "Maria" without spelling "John > Maria".
    const leafName = target.display.split(" > ").at(-1);
    if (leafName) byName.set(leafName.toLowerCase(), target);
  }
  const targets: BroadcastTarget[] = [];
  const errors: string[] = [];
  for (const rawPart of input.split(",")) {
    const requested = rawPart.trim();
    if (!requested) continue;
    const target = byName.get(requested.toLowerCase());
    if (target) targets.push(target);
    else errors.push(`Subagent "${requested}" is not running. Use its human name.`);
  }
  return {
    targets: Array.from(new Map(targets.map((target) => [target.display, target])).values()),
    errors,
  };
}

export function encodeNestedBroadcast(message: string, path: string[]): string {
  return `${BROADCAST_STEER_PREFIX}${JSON.stringify({ path, message })}`;
}

export function decodeNestedBroadcast(text: string): { path: string[]; message: string } | null {
  if (!text.startsWith(BROADCAST_STEER_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(BROADCAST_STEER_PREFIX.length));
    if (
      !Array.isArray(parsed?.path) ||
      !parsed.path.every((name: unknown) => typeof name === "string" && name.length > 0)
    )
      return null;
    if (typeof parsed?.message !== "string") return null;
    return { path: parsed.path, message: parsed.message };
  } catch {
    return null;
  }
}

export function collectRunningBroadcastTargetsFromResult(
  result: SingleResult,
  namePath: string[],
  topLevelId: number,
  targets: { all: BroadcastTarget[]; youngest: BroadcastTarget[] },
): boolean {
  let hasRunningDescendant = false;
  const completedIds = new Set<string>();
  const nestedDetails: SubagentDetails[] = [];
  for (const nested of nestedBroadcastHistory(result.messages)) {
    if (!isSubagentDetails(nested.details)) continue;
    const live = result.liveNestedSubagents?.[nested.toolCallId];
    if (nested.toolCallId) completedIds.add(nested.toolCallId);
    // Async launch receipts are not completed runs. Their live snapshot carries
    // current descendants, including children launched after the receipt.
    const hasRunningPlaceholder = nested.details.results.some((child) => child.exitCode === -1);
    nestedDetails.push(hasRunningPlaceholder && isSubagentDetails(live) ? live : nested.details);
  }
  for (const [toolCallId, live] of Object.entries(result.liveNestedSubagents ?? {})) {
    if (!completedIds.has(toolCallId) && isSubagentDetails(live)) nestedDetails.push(live);
  }
  for (const details of nestedDetails) {
    for (const child of details.results) {
      const childName = child.name || child.agent;
      if (collectRunningBroadcastTargetsFromResult(child, [...namePath, childName], topLevelId, targets)) {
        hasRunningDescendant = true;
      }
    }
  }

  if (result.exitCode !== -1) return hasRunningDescendant;
  const restPath = namePath.slice(1);
  const self: BroadcastTarget = {
    display: namePath.join(" > "),
    topLevelId,
    restPath,
    ...(result.startedAt !== undefined ? { startedAt: result.startedAt } : {}),
    ...(result.idle ? { idle: true } : {}),
  };
  targets.all.push(self);
  if (!hasRunningDescendant) targets.youngest.push(self);
  return true;
}

export function updateLatestBroadcastTargets(
  state: ExtensionState,
  details: SubagentDetails | undefined,
  topLevelBaseId = 1,
): void {
  updateBroadcastTargetCache(state, details, topLevelBaseId, collectRunningBroadcastTargetsFromResult);
  state.onActivityChanged?.();
}

export function getFallbackTopLevelTargets(state: ExtensionState): BroadcastTarget[] {
  return Array.from(state.activeSubagents.entries())
    .sort(([a], [b]) => a - b)
    .map(([id, active]) => ({
      display: active.name || active.agent,
      topLevelId: id,
      restPath: [],
      ...(active.startedAt !== undefined ? { startedAt: active.startedAt } : {}),
      ...(active.handle.isIdle?.() ? { idle: true } : {}),
    }));
}

export async function sendBroadcastToTargets(
  state: ExtensionState,
  message: string,
  targets: BroadcastTarget[],
  ctx: SessionContext,
): Promise<void> {
  const generation = state.lifecycleGeneration;
  const delivered: string[] = [];
  const missed: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    targets.map(async (target) => {
      const item = state.activeSubagents.get(target.topLevelId);
      if (!item) {
        missed.push(target.display);
        return;
      }
      try {
        const accepted = await item.handle.steer(
          target.restPath.length > 0 ? encodeNestedBroadcast(message, target.restPath) : message,
        );
        if (accepted === false) failed.push(target.display);
        else delivered.push(target.display);
      } catch {
        failed.push(target.display);
      }
    }),
  );
  if (generation !== state.lifecycleGeneration) return;
  if (delivered.length > 0) {
    ctx.ui.notify(`Sent steering message to subagent(s): ${delivered.join(", ")}`, "info");
  }
  if (missed.length > 0) {
    ctx.ui.notify(`Some selected subagents are no longer running: ${missed.join(", ")}`, "warning");
  }
  if (failed.length > 0) {
    ctx.ui.notify(`Some selected subagents could not accept steering: ${failed.join(", ")}`, "warning");
  }
}

/** Forward only machine-addressed messages. Ordinary input never selects recipients. */
export async function forwardNestedBroadcast(
  state: ExtensionState,
  text: string,
  ctx: SessionContext,
): Promise<boolean> {
  const nested = decodeNestedBroadcast(text);
  if (!nested) return false;
  const [rawTarget, ...restPath] = nested.path;
  // Missing targets are dropped rather than becoming prompts for this agent.
  if (!rawTarget) return true;
  for (const [id, item] of state.activeSubagents) {
    if ((item.name || item.agent).toLowerCase() !== rawTarget.toLowerCase()) continue;
    await sendBroadcastToTargets(
      state,
      nested.message,
      [{ display: nested.path.join(" > "), topLevelId: id, restPath }],
      ctx,
    );
    break;
  }
  return true;
}
