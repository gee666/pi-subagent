import { type SingleResult, type SubagentDetails, getNestedSubagentResults, isSubagentDetails } from "../types.js";
import type { SessionContext } from "./contracts.js";
import type { ExtensionState } from "./state.js";

export const BROADCAST_STEER_PREFIX = "__PI_SUBAGENT_BROADCAST_STEER__";

export interface BroadcastTarget {
  /** Human-name path, e.g. "John > Maria > Elena". */
  display: string;
  topLevelId: number;
  restPath: string[];
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
  for (const nested of getNestedSubagentResults(result.messages)) {
    if (!isSubagentDetails(nested.details)) continue;
    if (nested.toolCallId) completedIds.add(nested.toolCallId);
    nestedDetails.push(nested.details);
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
  const self = { display: namePath.join(" > "), topLevelId, restPath };
  targets.all.push(self);
  if (!hasRunningDescendant) targets.youngest.push(self);
  return true;
}

export function updateLatestBroadcastTargets(
  state: ExtensionState,
  details: SubagentDetails | undefined,
  topLevelBaseId = 1,
): void {
  state.latestBroadcastTargets.all = [];
  state.latestBroadcastTargets.youngest = [];
  if (!details) {
    for (const [id, active] of state.activeSubagents) {
      const display = active.name || active.agent;
      const target = { display, topLevelId: id, restPath: [] };
      state.latestBroadcastTargets.all.push(target);
      state.latestBroadcastTargets.youngest.push(target);
    }
    return;
  }
  details.results.forEach((result, index) => {
    collectRunningBroadcastTargetsFromResult(
      result,
      [result.name || result.agent],
      topLevelBaseId + index,
      state.latestBroadcastTargets,
    );
  });
  const dedupe = (targets: BroadcastTarget[]) =>
    Array.from(new Map(targets.map((target) => [target.display, target])).values())
      .filter((target) => state.activeSubagents.has(target.topLevelId))
      .sort((a, b) => a.display.localeCompare(b.display));
  state.latestBroadcastTargets.all = dedupe(state.latestBroadcastTargets.all);
  state.latestBroadcastTargets.youngest = dedupe(state.latestBroadcastTargets.youngest);
}

export function getFallbackTopLevelTargets(state: ExtensionState): BroadcastTarget[] {
  return Array.from(state.activeSubagents.entries())
    .sort(([a], [b]) => a - b)
    .map(([id, active]) => ({ display: active.name || active.agent, topLevelId: id, restPath: [] }));
}

export function sendBroadcastToTargets(
  state: ExtensionState,
  message: string,
  targets: BroadcastTarget[],
  ctx: SessionContext,
): void {
  const delivered: string[] = [];
  const missed: string[] = [];
  for (const target of targets) {
    const item = state.activeSubagents.get(target.topLevelId);
    if (!item) {
      missed.push(target.display);
      continue;
    }
    item.handle.steer(target.restPath.length > 0 ? encodeNestedBroadcast(message, target.restPath) : message);
    delivered.push(target.display);
  }
  if (delivered.length > 0) {
    ctx.ui.notify(`Broadcasted steering message to subagent(s): ${delivered.join(", ")}`, "info");
  }
  if (missed.length > 0) {
    ctx.ui.notify(`Some selected subagents are no longer running: ${missed.join(", ")}`, "warning");
  }
}

export async function askBroadcastForSteering(
  state: ExtensionState,
  message: string,
  ctx: SessionContext,
): Promise<"continue" | "handled"> {
  const nested = decodeNestedBroadcast(message);
  if (nested) {
    if (state.activeSubagents.size === 0) return "handled";
    const [rawTarget, ...restPath] = nested.path;
    let resolvedId: number | undefined;
    for (const [id, item] of state.activeSubagents) {
      if ((item.name || item.agent).toLowerCase() === rawTarget.toLowerCase()) {
        resolvedId = id;
        break;
      }
    }
    if (resolvedId === undefined) return "handled";
    sendBroadcastToTargets(
      state,
      nested.message,
      [{ display: nested.path.join(" > "), topLevelId: resolvedId, restPath }],
      ctx,
    );
    return "handled";
  }

  if (!ctx.hasUI || state.activeSubagents.size === 0) return "continue";

  const choice = await ctx.ui.select("Broadcast this steering message to subagents?", [
    "No",
    "All (+nested)",
    "Youngest",
    "Names (e.g. John, Maria)",
  ]);
  if (choice === "All (+nested)" || choice === "Youngest") {
    const fallback = getFallbackTopLevelTargets(state);
    const selected =
      choice === "Youngest"
        ? state.latestBroadcastTargets.youngest.length > 0
          ? state.latestBroadcastTargets.youngest
          : fallback
        : state.latestBroadcastTargets.all.length > 0
          ? state.latestBroadcastTargets.all
          : fallback;
    const current = selected.filter((target) => state.activeSubagents.has(target.topLevelId));
    if (current.length === 0) {
      ctx.ui.notify("No selected subagents are still running. Continuing with normal steering.", "warning");
      return "continue";
    }
    sendBroadcastToTargets(state, message, current, ctx);
    return "handled";
  }
  if (choice !== "Names (e.g. John, Maria)") return "continue";

  const answer = await ctx.ui.input("Subagent names to broadcast to (comma-separated)", "");
  if (!answer) return "continue";
  const current =
    state.latestBroadcastTargets.all.length > 0 ? state.latestBroadcastTargets.all : getFallbackTopLevelTargets(state);
  const parsed = parseBroadcastSelection(answer, current);
  const validatedTargets = parsed.targets;
  const errors = parsed.errors;
  if (errors.length > 0) {
    ctx.ui.notify(errors.slice(0, 4).join("\n"), "warning");
  }
  if (validatedTargets.length === 0) {
    ctx.ui.notify("No valid running subagents selected. Continuing with normal steering.", "warning");
    return "continue";
  }
  sendBroadcastToTargets(state, message, validatedTargets, ctx);
  return "handled";
}
