import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getActivitySnapshot, type ActivityEntry } from "./activity.js";
import type { ExtensionState } from "./state.js";

export function elapsedLabel(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

/** One terminal line, with an explicit overflow count instead of wrapping the editor. */
export function formatActivityLine(entries: ActivityEntry[], width: number, now = Date.now()): string {
  const running = entries.filter((entry) => entry.status === "running");
  const idle = entries.length - running.length;
  const prefix = `Running ${running.length}`;
  const idleSuffix = idle ? ` · ${idle} idle` : "";
  if (!running.length) return truncateToWidth(`${prefix}${idleSuffix}`, Math.max(0, width), "");
  let line = `${prefix}:`;
  for (let i = 0; i < running.length; i++) {
    const entry = running[i];
    const next = `${line}${i ? " ·" : ""} ${entry.name} ${elapsedLabel(entry.startedAt, now)}`;
    const remaining = running.length - i - 1;
    const suffix = `${remaining ? ` · +${remaining}` : ""}${idleSuffix}`;
    if (visibleWidth(next + suffix) > width) {
      return truncateToWidth(`${line} · +${running.length - i}${idleSuffix}`, Math.max(0, width), "");
    }
    line = next;
  }
  return truncateToWidth(line + idleSuffix, Math.max(0, width), "");
}

export function registerActivityWidget(state: ExtensionState): void {
  let dispose = () => {};
  state.pi.on("session_start", (_event, ctx) => {
    dispose();
    if (state.disabled || ctx.mode !== "tui" || !ctx.hasUI || !("setWidget" in ctx.ui)) return;
    const generation = state.lifecycleGeneration;
    let interval: ReturnType<typeof setInterval> | undefined;
    let queued: ReturnType<typeof setTimeout> | undefined;
    let requestRender = () => {};
    let entries = getActivitySnapshot(state);
    let lastRefresh = -Infinity;
    const refresh = () => {
      if (!state.sessionActive || generation !== state.lifecycleGeneration) return;
      lastRefresh = Date.now();
      entries = getActivitySnapshot(state, lastRefresh);
      if (entries.length && !interval) {
        interval = setInterval(refresh, 1000);
        interval.unref?.();
      }
      if (!entries.length && interval) {
        clearInterval(interval);
        interval = undefined;
      }
      requestRender();
    };
    const onChanged = () => {
      if (queued) return;
      queued = setTimeout(
        () => {
          queued = undefined;
          refresh();
        },
        Math.max(0, 250 - (Date.now() - lastRefresh)),
      );
      queued.unref?.();
    };
    state.onActivityChanged = onChanged;
    ctx.ui.setWidget(
      "subagent-running",
      (tui, theme) => {
        requestRender = () => tui.requestRender();
        return {
          render: (width) => [theme.fg("dim", formatActivityLine(entries, width))],
          invalidate() {},
        };
      },
      { placement: "aboveEditor" },
    );
    dispose = () => {
      if (queued) clearTimeout(queued);
      if (interval) clearInterval(interval);
      queued = undefined;
      interval = undefined;
      if (state.onActivityChanged === onChanged) state.onActivityChanged = undefined;
      ctx.ui.setWidget("subagent-running", undefined);
    };
    refresh();
  });
  state.pi.on("session_shutdown", () => {
    dispose();
    dispose = () => {};
  });
}
