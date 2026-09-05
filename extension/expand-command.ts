import { buildSubagentDetail, findNameRecord, type SubagentDetail } from "../detail.js";
import { readNamesRegistry, type NamesRegistry, type SubagentNameRecord } from "../names.js";
import { SubagentPager, SubagentPicker, filterPickerItems, type PickerItem } from "../overlay.js";
import type { SessionContext } from "./contracts.js";
import type { ExtensionState } from "./state.js";

export function resolveDetailSessionDir(state: ExtensionState, record: SubagentNameRecord): string {
  // Read-only mirror of resolveResumeTarget: a non-owner sees its own fork if
  // one was already created, otherwise the original session.
  if (record.ownerSessionId !== state.currentOwnerId) {
    const fork = record.forks?.[state.currentOwnerId];
    if (fork?.sessionDir) return fork.sessionDir;
  }
  return record.sessionDir;
}

export function readCurrentRegistry(state: ExtensionState): NamesRegistry | undefined {
  if (!state.currentNamesFile) return undefined;
  try {
    return readNamesRegistry(state.currentNamesFile);
  } catch {
    return undefined;
  }
}

export function registerSubagentExpandCommand(state: ExtensionState): void {
  if (typeof state.pi.registerCommand !== "function") return;

  state.pi.registerCommand("subagent-expand", {
    description: "Show the full work of one named subagent (prompt, tools, children, resumes)",
    getArgumentCompletions: (prefix: string) => {
      const registry = readCurrentRegistry(state);
      if (!registry) return null;
      // Fuzzy, not prefix-only: with hundreds of names the user needs to find
      // one by any fragment of the name, agent type, or task.
      const pickerItems: PickerItem[] = Object.values(registry.agents ?? {})
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
        .map((record) => ({ name: record.name, agent: record.agent, task: record.task }));
      const items = filterPickerItems(pickerItems, prefix).map((item) => ({
        value: item.name,
        label: item.name,
        description: `${item.agent}${item.task ? ` — ${item.task.replace(/\s+/g, " ").slice(0, 80)}` : ""}`,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: SessionContext) => {
      const name = (args ?? "").trim().split(/\s+/)[0] ?? "";
      const uiAvailable = ctx?.mode === "tui" && ctx?.ui && typeof ctx.ui.custom === "function";
      if (!uiAvailable) {
        const message = "/subagent-expand is a UI-only feature (interactive TUI mode).";
        if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(message, "warning");
        else console.log(`[pi-subagent] ${message}`);
        return;
      }

      const registry = readCurrentRegistry(state);
      if (!registry) {
        ctx.ui.notify("No subagent name registry for this session yet.", "warning");
        return;
      }
      const sortedRecords = Object.values(registry.agents ?? {}).sort(
        (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
      );
      if (sortedRecords.length === 0) {
        ctx.ui.notify("No subagents have run in this session yet.", "info");
        return;
      }

      let record = name ? findNameRecord(registry, name) : undefined;
      if (!record) {
        if (name) {
          const suggestions = filterPickerItems(
            sortedRecords.map((item) => ({ name: item.name, agent: item.agent, task: item.task })),
            name,
          )
            .slice(0, 10)
            .map((item) => item.name);
          ctx.ui.notify(
            `Unknown subagent "${name}".${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""}`,
            "error",
          );
          return;
        }
        // A delegation tree can hold hundreds of names, so the chooser is a
        // searchable overlay rather than a flat select list.
        const picked = await ctx.ui.custom(
          (tui, theme, _keybindings, done: (value: string | undefined) => void) =>
            new SubagentPicker({
              items: sortedRecords.map((item) => ({ name: item.name, agent: item.agent, task: item.task })),
              getRows: () => tui?.terminal?.rows ?? 30,
              theme,
              requestRender: () => tui?.requestRender?.(),
              onPick: (value) => done(value),
            }),
          {
            overlay: true,
            overlayOptions: { anchor: "center", width: "80%", maxHeight: "90%", margin: 1 },
          },
        );
        if (!picked) return;
        record = findNameRecord(registry, picked);
        if (!record) return;
      }

      let detail: SubagentDetail;
      try {
        detail = buildSubagentDetail(record, { sessionDir: resolveDetailSessionDir(state, record) });
      } catch (err) {
        ctx.ui.notify(`Failed to read subagent session: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }

      await ctx.ui.custom(
        (tui, theme, _keybindings, done: (value: void) => void) =>
          new SubagentPager({
            detail,
            resolveDetail: (childName) => {
              const childRecord = findNameRecord(registry, childName);
              if (!childRecord) return undefined;
              try {
                return buildSubagentDetail(childRecord, { sessionDir: resolveDetailSessionDir(state, childRecord) });
              } catch {
                return undefined;
              }
            },
            getRows: () => tui?.terminal?.rows ?? 30,
            theme,
            requestRender: () => tui?.requestRender?.(),
            onClose: () => done(undefined),
          }),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 },
        },
      );
    },
  });
}
