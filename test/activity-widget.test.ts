import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { elapsedLabel, formatActivityLine, registerActivityWidget } from "../extension/activity-widget.js";
import type { ActivityEntry } from "../extension/activity.js";
import { createExtensionState } from "../extension/state.js";
import { hostDouble } from "./helpers/extension.js";

function entry(name: string, startedAt = 0, status: ActivityEntry["status"] = "running"): ActivityEntry {
  return { name, startedAt, status, depth: 0, path: [name], topLevelId: 1 };
}

test("elapsed labels clamp future starts and cross second, minute and hour boundaries", () => {
  for (const [milliseconds, expected] of [
    [-1000, "0s"],
    [0, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [59999, "59s"],
    [60000, "1m0s"],
    [61000, "1m1s"],
    [3599999, "59m59s"],
    [3600000, "1h0m"],
    [3660000, "1h1m"],
    [90000000, "25h0m"],
  ] as const)
    assert.equal(elapsedLabel(5000, 5000 + milliseconds), expected);
});

test("wide formatting shows live names and elapsed time but only counts idle workers", () => {
  const entries = [entry("Anna"), entry("Sleeping", 0, "idle"), entry("测试", 60000)];
  const original = structuredClone(entries);
  assert.equal(formatActivityLine(entries, 120, 61000), "Running 2: Anna 1m1s · 测试 1s · 1 idle");
  assert.equal(formatActivityLine(entries, 120, 62000), "Running 2: Anna 1m2s · 测试 2s · 1 idle");
  assert.equal(formatActivityLine([], 120, 0), "Running 0");
  assert.equal(formatActivityLine([entry("Sleeping", 0, "idle")], 120, 0), "Running 0 · 1 idle");
  assert.deepEqual(entries, original);
});

test("narrow formatting reserves overflow and idle counts and respects Unicode cell widths", () => {
  const entries = [entry("测试"), entry("Bea"), entry("Hidden", 0, "idle")];
  const full = "Running 2: 测试 0s · Bea 0s · 1 idle";
  const partial = "Running 2: 测试 0s · +1 · 1 idle";
  assert.equal(formatActivityLine(entries, visibleWidth(full), 0), full);
  assert.equal(formatActivityLine(entries, visibleWidth(partial), 0), partial);
  assert.equal(formatActivityLine(entries, 24, 0), "Running 2: · +2 · 1 idle");
  for (const name of ["测试", "👩‍💻", "e\u0301", "A very long worker name"]) {
    for (const width of [-1, 0, 1, 2, 8, 12, 20, 40, 120]) {
      const line = formatActivityLine([entry(name), ...entries], width, 61000);
      assert.ok(visibleWidth(line) <= Math.max(0, width), `${name} at width ${width}: ${line}`);
      assert.doesNotMatch(line, /[\r\n]/);
    }
  }
});

type LifecycleEvent = Extract<ExtensionEvent, { type: "session_start" | "session_shutdown" }>;
type Handler = (event: LifecycleEvent, ctx: ExtensionContext) => unknown;

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 10000 });
  const handlers = new Map<string, Handler>();
  const on = (name: string, handler: Handler) => {
    assert.ok(name === "session_start" || name === "session_shutdown");
    assert.ok(!handlers.has(name));
    handlers.set(name, handler);
  };
  const state = createExtensionState(
    hostDouble<ExtensionAPI>({ getFlag: () => undefined, on: on as ExtensionAPI["on"] }),
  );
  state.disabled = false;
  state.sessionActive = true;
  let renders = 0;
  let widget: Component | undefined;
  const calls: Array<{ key: string; installed: boolean; placement?: string }> = [];
  const tui = hostDouble<TUI>({
    requestRender() {
      renders++;
    },
  });
  const theme = hostDouble<Theme>({ fg: (_color, text) => text });
  const setWidget: ExtensionContext["ui"]["setWidget"] = (key, content, options) => {
    calls.push({ key, installed: content !== undefined, placement: options?.placement });
    assert.equal(typeof content === "function" || content === undefined, true);
    widget = typeof content === "function" ? content(tui, theme) : undefined;
  };
  const ctx = hostDouble<ExtensionContext>({
    mode: "tui",
    hasUI: true,
    ui: hostDouble<ExtensionContext["ui"]>({ setWidget }),
  });
  registerActivityWidget(state);
  function emit(event: LifecycleEvent, context = ctx) {
    const handler = handlers.get(event.type);
    assert.ok(handler);
    return handler(event, context);
  }
  const start = (context = ctx) => emit({ type: "session_start", reason: "new" }, context);
  const shutdown = () => emit({ type: "session_shutdown", reason: "quit" });
  t.after(shutdown);
  function add(name: string) {
    state.activeSubagents.set(1, { name, agent: "worker", task: "work", startedAt: 10000, handle: { steer() {} } });
  }
  const screen = () => {
    assert.ok(widget);
    return widget.render(120).join("\n");
  };
  return { state, calls, start, shutdown, add, screen, renders: () => renders };
}

test("registration installs one widget above the editor and does not poll while empty", (t) => {
  const f = fixture(t);
  f.start();
  assert.deepEqual(f.calls, [{ key: "subagent-running", installed: true, placement: "aboveEditor" }]);
  assert.equal(typeof f.state.onActivityChanged, "function");
  assert.equal(f.screen(), "Running 0");
  const renders = f.renders();
  t.mock.timers.tick(5000);
  assert.equal(f.renders(), renders);
});

test("RPC, headless and disabled sessions make no UI calls or timers", (t) => {
  const f = fixture(t);
  const contexts = [
    hostDouble<ExtensionContext>({ mode: "rpc", hasUI: true }),
    hostDouble<ExtensionContext>({ mode: "tui", hasUI: false }),
  ];
  for (const ctx of contexts) f.start(ctx);
  f.state.disabled = true;
  f.start(hostDouble<ExtensionContext>({}));
  t.mock.timers.tick(5000);
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.onActivityChanged, undefined);
  assert.equal(f.renders(), 0);
});

test("live activity starts ticking, updates names and time, then stops when empty", (t) => {
  const f = fixture(t);
  f.start();
  f.add("Anna");
  f.state.onActivityChanged?.();
  t.mock.timers.tick(250);
  assert.equal(f.screen(), "Running 1: Anna 0s");
  t.mock.timers.tick(1000);
  assert.equal(f.screen(), "Running 1: Anna 1s");
  f.add("Bea");
  t.mock.timers.tick(1000);
  assert.equal(f.screen(), "Running 1: Bea 2s");
  assert.equal(f.calls.filter((call) => call.installed).length, 1, "ticks update the existing widget");
  f.state.activeSubagents.clear();
  f.state.onActivityChanged?.();
  t.mock.timers.tick(250);
  assert.equal(f.screen(), "Running 0");
  const renders = f.renders();
  t.mock.timers.tick(5000);
  assert.equal(f.renders(), renders);
});

test("activity callback bursts coalesce and respect the refresh throttle", (t) => {
  const f = fixture(t);
  f.start();
  f.add("Anna");
  const initial = f.renders();
  for (let i = 0; i < 100; i++) f.state.onActivityChanged?.();
  t.mock.timers.tick(249);
  assert.equal(f.renders(), initial);
  t.mock.timers.tick(1);
  assert.equal(f.renders(), initial + 1);
  assert.match(f.screen(), /Anna/);
  f.add("Bea");
  for (let i = 0; i < 100; i++) f.state.onActivityChanged?.();
  t.mock.timers.tick(249);
  assert.equal(f.renders(), initial + 1);
  t.mock.timers.tick(1);
  assert.equal(f.renders(), initial + 2);
  assert.match(f.screen(), /Bea/);
});

test("shutdown clears widget, callback, interval and queued refresh", (t) => {
  const f = fixture(t);
  f.add("Anna");
  f.start();
  f.state.onActivityChanged?.();
  f.shutdown();
  assert.equal(f.state.onActivityChanged, undefined);
  assert.deepEqual(f.calls.at(-1), { key: "subagent-running", installed: false, placement: undefined });
  const renders = f.renders();
  t.mock.timers.tick(10000);
  assert.equal(f.renders(), renders);
  const calls = f.calls.length;
  f.shutdown();
  assert.equal(f.calls.length, calls, "shutdown is idempotent");
});

test("stale generations and inactive sessions do not render queued or interval updates", (t) => {
  const f = fixture(t);
  f.add("Anna");
  f.start();
  f.state.onActivityChanged?.();
  f.state.lifecycleGeneration++;
  const renders = f.renders();
  t.mock.timers.tick(2000);
  assert.equal(f.renders(), renders);
  f.start();
  f.state.onActivityChanged?.();
  f.state.sessionActive = false;
  const restartedRenders = f.renders();
  t.mock.timers.tick(2000);
  assert.equal(f.renders(), restartedRenders);
});

test("session restart replaces the old widget and owns only one refresh interval", (t) => {
  const f = fixture(t);
  f.add("Anna");
  f.start();
  const oldCallback = f.state.onActivityChanged;
  oldCallback?.();
  f.state.lifecycleGeneration++;
  f.add("Bea");
  f.start();
  assert.notEqual(f.state.onActivityChanged, oldCallback);
  assert.deepEqual(
    f.calls.map((call) => call.installed),
    [true, false, true],
  );
  assert.match(f.screen(), /Bea/);
  const renders = f.renders();
  t.mock.timers.tick(1000);
  assert.equal(f.renders(), renders + 1);
});
