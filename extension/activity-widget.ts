import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  if (!running.length) return "";
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
  let onAgentState = (_busy: boolean, _ctx: ExtensionContext) => {};
  state.pi.on("before_agent_start", (_event, ctx) => onAgentState(true, ctx));
  state.pi.on("turn_start", (_event, ctx) => onAgentState(true, ctx));
  state.pi.on("agent_settled", (_event, ctx) => onAgentState(false, ctx));
  state.pi.on("session_start", (_event, ctx) => {
    dispose();
    if (state.disabled || ctx.mode !== "tui" || !ctx.hasUI || !("setWidget" in ctx.ui)) return;
    const generation = state.lifecycleGeneration;
    let interval: ReturnType<typeof setInterval> | undefined;
    let queued: ReturnType<typeof setTimeout> | undefined;
    let requestRender = () => {};
    let entries = getActivitySnapshot(state);
    let context = ctx;
    let busy = false;
    let disposed = false;
    let waiting: Loader | undefined;
    let createWaiting: (() => Loader) | undefined;
    const hasWork = () => entries.length > 0 || state.backgroundJobs.size > 0 || state.activeSubagents.size > 0;
    const canWait = () => !busy && hasWork() && "isIdle" in context && context.isIdle();
    const updateWaiting = () => {
      if (canWait()) waiting ??= createWaiting?.();
      else {
        waiting?.stop();
        waiting = undefined;
      }
    };
    let lastRefresh = -Infinity;
    const refresh = () => {
      if (disposed) return;
      if (!state.sessionActive || generation !== state.lifecycleGeneration) {
        dispose();
        return;
      }
      lastRefresh = Date.now();
      entries = getActivitySnapshot(state, lastRefresh);
      updateWaiting();
      if (hasWork() && !interval) {
        interval = setInterval(refresh, 1000);
        interval.unref?.();
      }
      if (!hasWork() && interval) {
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
    onAgentState = (active, latest) => {
      busy = active;
      context = latest;
      refresh();
    };
    ctx.ui.setWidget(
      "subagent-running",
      (tui, theme) => {
        requestRender = () => tui.requestRender();
        // Native setWorkingVisible only works during streaming. Leave native Working alone.
        createWaiting = () =>
          new Loader(
            tui,
            (text) => theme.fg("accent", text),
            (text) => theme.fg("muted", text),
            "Waiting for subagents - don't close the session",
          );
        return {
          render: (width) => {
            const activity = formatActivityLine(entries, width);
            const running = activity ? [theme.fg("accent", activity)] : [];
            if (!waiting || !canWait()) return running;
            const line = waiting.render(Math.max(80, width))[1]?.trimEnd() ?? "";
            return [truncateToWidth(line, Math.max(0, width), ""), ...running];
          },
          invalidate() {
            waiting?.invalidate();
          },
        };
      },
      { placement: "aboveEditor" },
    );
    dispose = () => {
      if (disposed) return;
      disposed = true;
      onAgentState = () => {};
      waiting?.stop();
      waiting = undefined;
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
