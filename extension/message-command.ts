import {
  getFallbackTopLevelTargets,
  parseBroadcastSelection,
  sendBroadcastToTargets,
  updateLatestBroadcastTargets,
  type BroadcastTarget,
} from "./broadcast.js";
import type { ExtensionState } from "./state.js";

export function registerMessageSubagentCommand(state: ExtensionState): void {
  if (typeof state.pi.registerCommand !== "function") return;

  state.pi.registerCommand("message_subagent", {
    description: "Choose running subagents, then send them a steering message",
    handler: async (_args, ctx) => {
      if (state.disabled) return;
      if (!ctx.hasUI) {
        ctx.ui.notify("/message_subagent requires an interactive or RPC UI.", "warning");
        return;
      }
      if (state.activeSubagents.size === 0) {
        ctx.ui.notify("No subagents are running.", "info");
        return;
      }
      const generation = state.lifecycleGeneration;
      const isCurrent = () => generation === state.lifecycleGeneration && !state.disabled;
      const choice = await ctx.ui.select("Message subagents", [
        "All (+nested)",
        "All",
        "Youngest",
        "Names (e.g. John, Maria)",
      ]);
      if (!choice || !isCurrent()) return;

      updateLatestBroadcastTargets(state, undefined);
      let targets: BroadcastTarget[];
      if (choice === "Names (e.g. John, Maria)") {
        const names = await ctx.ui.input("Subagent names (comma-separated)", "John, Maria");
        if (!names?.trim() || !isCurrent()) return;
        updateLatestBroadcastTargets(state, undefined);
        const parsed = parseBroadcastSelection(names, state.latestBroadcastTargets.all);
        if (parsed.errors.length > 0) ctx.ui.notify(parsed.errors.slice(0, 4).join("\n"), "warning");
        targets = parsed.targets;
      } else if (choice === "All (+nested)") {
        targets = state.latestBroadcastTargets.all;
      } else if (choice === "All") {
        targets = getFallbackTopLevelTargets(state);
      } else if (choice === "Youngest") {
        targets = state.latestBroadcastTargets.youngest;
      } else {
        return;
      }
      if (targets.length === 0) {
        ctx.ui.notify("No valid running subagents selected.", "warning");
        return;
      }

      const message = await ctx.ui.input(`Message to ${targets.map((target) => target.display).join(", ")}`);
      if (!message?.trim() || !isCurrent()) return;
      await sendBroadcastToTargets(state, message, targets, ctx);
    },
  });
}
