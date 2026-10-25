import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { updateCombinedUsageStatus } from "../extension/runtime.js";
import { createExtensionState } from "../extension/state.js";
import { emptyUsageSummary, buildSubagentDetails } from "../types.js";
import { hostDouble } from "./helpers/extension.js";
import { makeResult } from "./helpers/results.js";

function fixture() {
  const state = createExtensionState(hostDouble<ExtensionAPI>({ getFlag: () => undefined }));
  state.disabled = false;
  const entries: unknown[] = [];
  let widget: Component | undefined;
  let calls = 0;
  let currentColor = "dim";
  const colors: string[] = [];
  const theme = hostDouble<Theme>({
    fg: (color, text) => {
      colors.push(color);
      return `${currentColor}:${text}`;
    },
  });
  const ctx = hostDouble<ExtensionContext>({
    mode: "tui",
    hasUI: true,
    sessionManager: hostDouble<ExtensionContext["sessionManager"]>({
      getEntries: () => entries as ReturnType<ExtensionContext["sessionManager"]["getEntries"]>,
      getLeafId: () => String(entries.length),
      getSessionFile: () => undefined,
    }),
    ui: hostDouble<ExtensionContext["ui"]>({
      setStatus() {
        assert.fail("usage must not write to the status line");
      },
      setWidget(key, content, options) {
        calls++;
        assert.equal(key, "subagent-usage");
        assert.equal(options?.placement, "belowEditor");
        assert.ok(content === undefined || typeof content === "function");
        widget = typeof content === "function" ? content(hostDouble<TUI>({}), theme) : undefined;
      },
    }),
  });
  state.latestSessionCtx = ctx;
  return {
    state,
    ctx,
    entries,
    colors,
    get widget() {
      return widget;
    },
    get calls() {
      return calls;
    },
    changeTheme() {
      currentColor = "new";
    },
  };
}

test("usage widget stays absent for empty sessions, parent-only usage, and empty launches", () => {
  const f = fixture();
  updateCombinedUsageStatus(f.state);
  assert.equal(f.widget, undefined);
  f.entries.push({
    id: "parent",
    type: "message",
    message: {
      role: "assistant",
      provider: "test",
      usage: { input: 10, output: 5, cost: { total: 2 } },
    },
  });
  updateCombinedUsageStatus(f.state);
  assert.equal(f.widget, undefined);
  f.state.activeSubagentUsageSummaries.set("empty", emptyUsageSummary());
  updateCombinedUsageStatus(f.state);
  assert.equal(f.widget, undefined);
});

test("live zero-cost workers show one dim line, clipped to terminal width and recolored on render", () => {
  const f = fixture();
  f.state.activeSubagentUsageSummaries.set("worker", { ...emptyUsageSummary(), subagentCount: 1 });
  updateCombinedUsageStatus(f.state);
  assert.ok(f.widget);
  assert.match(f.widget.render(120)[0], /^dim:.*WITH SUBS.*\(1\)/);
  assert.deepEqual(f.colors, ["dim"]);
  for (const width of [0, 1, 10, 40]) {
    const lines = f.widget.render(width);
    assert.equal(lines.length, 1);
    // The fake theme adds a prefix in place of zero-width ANSI styling.
    assert.ok(visibleWidth(lines[0].slice(4)) <= width);
  }
  f.changeTheme();
  f.widget.invalidate();
  assert.match(f.widget.render(120)[0], /^new:/);
});

test("completed workers remain visible after reload, but switching to an unused session clears the widget", () => {
  const f = fixture();
  f.entries.push({
    id: "done",
    type: "message",
    message: {
      role: "toolResult",
      toolName: "subagents",
      details: buildSubagentDetails("single", "spawn", null, [makeResult()]),
    },
  });
  updateCombinedUsageStatus(f.state);
  assert.ok(f.widget);
  assert.match(f.widget.render(120)[0], /WITH SUBS.*\(1\)/);
  f.entries.length = 0;
  updateCombinedUsageStatus(f.state);
  assert.equal(f.widget, undefined);
});

test("disabling clears the widget and non-TUI hosts receive no widget calls", () => {
  const f = fixture();
  f.state.activeSubagentUsageSummaries.set("worker", { ...emptyUsageSummary(), subagentCount: 1 });
  updateCombinedUsageStatus(f.state);
  assert.ok(f.widget);
  f.state.disabled = true;
  updateCombinedUsageStatus(f.state);
  assert.equal(f.widget, undefined);
  const calls = f.calls;
  for (const mode of ["rpc", "json", "print"] as const) {
    updateCombinedUsageStatus(f.state, { ...f.ctx, mode });
  }
  updateCombinedUsageStatus(f.state, { ...f.ctx, hasUI: false });
  assert.equal(f.calls, calls);
});
