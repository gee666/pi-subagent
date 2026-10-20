import { readDetailBudget } from "../ui/detail-budget.js";
import { statSync } from "node:fs";
import { buildSubagentDetail, findNameRecord, sessionFilesIn, type SubagentDetail } from "../detail.js";
import { readNamesRegistry, type NamesRegistry, type SubagentNameRecord } from "../names.js";
import { filterPickerItems, type PickerItem } from "../overlay.js";
import { SubagentExpandView } from "../ui/expand-view.js";
import { getActivitySnapshot, type ActivityEntry } from "./activity.js";
import type { SessionContext } from "./contracts.js";
import type { ExtensionState } from "./state.js";

const registryCache = new WeakMap<
  ExtensionState,
  {
    file: string;
    generation: number;
    signature: string;
    registry: NamesRegistry;
  }
>();

function fileSignature(file: string): string {
  const stat = statSync(file);
  return `${stat.mtimeMs}:${stat.size}`;
}

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
  if (state.disabled || !state.currentNamesFile) {
    registryCache.delete(state);
    return undefined;
  }
  try {
    const file = state.currentNamesFile;
    const generation = state.lifecycleGeneration;
    const signature = fileSignature(file);
    const cached = registryCache.get(state);
    if (cached?.file === file && cached.generation === generation && cached.signature === signature) {
      return cached.registry;
    }
    const registry = readNamesRegistry(file);
    // Only registry references live here. Transcripts belong to the open overlay.
    registryCache.set(state, { file, generation, signature, registry });
    return registry;
  } catch {
    registryCache.delete(state);
    return undefined;
  }
}

/** Snapshot order breaks live ties by top-level id and path, not registry age. */
export function buildExpandPickerItems(registry: NamesRegistry, activity: ActivityEntry[]): PickerItem[] {
  const live = new Map(activity.map((entry, index) => [entry.name.toLowerCase(), { entry, index }]));
  const rank = (entry?: ActivityEntry) => (entry?.status === "running" ? 0 : entry ? 1 : 2);
  return Object.values(registry.agents ?? {})
    .map((record) => ({ record, live: live.get(record.name.toLowerCase()) }))
    .sort((a, b) => {
      const group = rank(a.live?.entry) - rank(b.live?.entry);
      if (group) return group;
      if (a.live && b.live) {
        return a.live.entry.depth - b.live.entry.depth || a.live.index - b.live.index;
      }
      return (b.record.createdAt ?? 0) - (a.record.createdAt ?? 0);
    })
    .map(({ record, live }) => ({
      name: record.name,
      agent: record.agent,
      task: record.task,
      intelligence: record.intelligence,
      ...(live ? { status: live.entry.status, depth: live.entry.depth } : {}),
    }));
}

export function registerSubagentExpandCommand(state: ExtensionState): void {
  if (typeof state.pi.registerCommand !== "function") return;

  state.pi.registerCommand("subagent-expand", {
    description: "Show the full work of one named subagent (prompt, tools, children, resumes)",
    getArgumentCompletions: (prefix: string) => {
      const registry = readCurrentRegistry(state);
      if (!registry) return null;
      const pickerItems = buildExpandPickerItems(registry, getActivitySnapshot(state));
      const items = filterPickerItems(pickerItems, prefix).map((item) => ({
        value: item.name,
        label: item.name,
        description: `${item.agent}${item.task ? ` — ${item.task.replace(/\s+/g, " ").slice(0, 80)}` : ""}`,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: SessionContext) => {
      if (state.disabled) return;
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
      const items = buildExpandPickerItems(registry, getActivitySnapshot(state));
      if (items.length === 0) {
        ctx.ui.notify("No subagents have run in this session yet.", "info");
        return;
      }

      const record = name ? findNameRecord(registry, name) : undefined;
      if (!record && name) {
        const suggestions = filterPickerItems(items, name)
          .slice(0, 10)
          .map((item) => item.name);
        ctx.ui.notify(
          `Unknown subagent "${name}".${suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""}`,
          "error",
        );
        return;
      }

      const generation = state.lifecycleGeneration;
      const namesFile = state.currentNamesFile;
      const owner = state.currentOwnerId;
      const isCurrent = () =>
        !state.disabled &&
        state.lifecycleGeneration === generation &&
        state.currentNamesFile === namesFile &&
        state.currentOwnerId === owner;
      // An overlay-local LRU. File signatures catch appends, replacement, and new session files.
      const detailCache = new Map<string, { signature: string; detail: SubagentDetail }>();
      const resolveDetail = (selectedName: string): SubagentDetail | undefined => {
        if (!isCurrent()) return undefined;
        const current = readCurrentRegistry(state);
        const selected = current && findNameRecord(current, selectedName);
        if (!selected) return undefined;
        try {
          const sessionDir = resolveDetailSessionDir(state, selected);
          const files = sessionFilesIn(sessionDir);
          const signature = JSON.stringify([
            selected,
            readDetailBudget(selected.budget),
            sessionDir,
            files.map((file) => [file, fileSignature(file)]),
          ]);
          const key = selected.name.toLowerCase();
          const cached = detailCache.get(key);
          let detail = cached?.signature === signature ? cached.detail : undefined;
          detail ??= buildSubagentDetail(selected, { sessionDir });
          detailCache.delete(key);
          detailCache.set(key, { signature, detail });
          if (detailCache.size > 8) detailCache.delete(detailCache.keys().next().value!);
          return detail;
        } catch (err) {
          ctx.ui.notify(
            `Failed to read subagent session: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          return undefined;
        }
      };
      const detail = record ? resolveDetail(record.name) : undefined;
      if (record && !detail) return;

      let view: SubagentExpandView | undefined;
      try {
        await ctx.ui.custom(
          (tui, theme, _keybindings, done: (value: void) => void) => {
            view = new SubagentExpandView({
              items,
              getItems: () => {
                if (!isCurrent()) {
                  view?.dispose();
                  done(undefined);
                  return [];
                }
                const current = readCurrentRegistry(state);
                return current ? buildExpandPickerItems(current, getActivitySnapshot(state)) : [];
              },
              detail,
              resolveDetail,
              getRows: () => tui?.terminal?.rows ?? 30,
              theme,
              requestRender: () => tui?.requestRender?.(),
              onClose: () => done(undefined),
            });
            return view;
          },
          {
            overlay: true,
            overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 },
          },
        );
      } finally {
        view?.dispose();
        detailCache.clear();
      }
    },
  });
}
