import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { DetailTheme } from "../detail.js";
import { registerSubagentExpandCommand } from "../extension/expand-command.js";
import { createExtensionState } from "../extension/state.js";
import { emptyNamesRegistry } from "../names.js";
import { SubagentExpandView } from "../ui/expand-view.js";

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;
type Factory = (
  tui: { terminal: { rows: number }; requestRender: () => void },
  theme: DetailTheme,
  keybindings: unknown,
  done: (value: void) => void,
) => SubagentExpandView;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function fixture(t: TestContext, names = ["Anna"]) {
  const root = path.join(process.cwd(), "tmp");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "expand-command-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let command: Command | undefined;
  const pi = {
    getFlag: () => undefined,
    registerCommand: (name: string, value: Command) => {
      assert.equal(name, "subagent:expand");
      command = value;
    },
  } as unknown as ExtensionAPI;
  const state = createExtensionState(pi);
  state.disabled = false;
  state.currentOwnerId = "owner";
  state.currentNamesFile = path.join(dir, "names.json");
  const registry = emptyNamesRegistry();
  for (const name of names) {
    const sessionDir = path.join(dir, name);
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(
      path.join(sessionDir, "session.jsonl"),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: `task for ${name}` },
      }) + "\n",
    );
    registry.agents[name] = {
      name,
      agent: "worker",
      task: "work",
      ownerSessionId: "owner",
      sessionDir,
      createdAt: 1,
      forks: {},
    };
  }
  const saveRegistry = () => fs.writeFileSync(state.currentNamesFile, JSON.stringify(registry));
  saveRegistry();
  registerSubagentExpandCommand(state);
  assert.ok(command);
  let doneCalls = 0;
  const notices: string[] = [];
  const run = async (body: (view: SubagentExpandView) => void) => {
    const ctx = {
      mode: "tui",
      ui: {
        notify: (message: string) => notices.push(message),
        custom: async (factory: Factory) => {
          const view = factory({ terminal: { rows: 30 }, requestRender: () => {} }, theme, {}, () => doneCalls++);
          assert.ok(view instanceof SubagentExpandView);
          body(view);
        },
      },
    } as unknown as ExtensionCommandContext;
    await command!.handler("", ctx);
    assert.deepEqual(notices, []);
  };
  return { state, dir, registry, command, saveRegistry, run, doneCalls: () => doneCalls };
}

function transcriptReads(t: TestContext) {
  const read = t.mock.method(fs, "readFileSync");
  syncBuiltinESMExports();
  t.after(() => {
    read.mock.restore();
    syncBuiltinESMExports();
  });
  return (file: string) => read.mock.calls.filter((call) => call.arguments[0] === file).length;
}

test("autocomplete reuses registry references without loading transcripts", async (t) => {
  const f = fixture(t);
  const reads = transcriptReads(t);
  assert.deepEqual(
    (await f.command.getArgumentCompletions?.(""))?.map((item) => item.value),
    ["Anna"],
  );
  assert.deepEqual(
    (await f.command.getArgumentCompletions?.("worker"))?.map((item) => item.value),
    ["Anna"],
  );
  assert.equal(reads(f.state.currentNamesFile), 1);
  assert.equal(reads(path.join(f.dir, "Anna", "session.jsonl")), 0);
  f.registry.agents.Olga = { ...f.registry.agents.Anna, name: "Olga", createdAt: 2 };
  f.saveRegistry();
  assert.deepEqual(
    (await f.command.getArgumentCompletions?.(""))?.map((item) => item.value),
    ["Olga", "Anna"],
  );
  assert.equal(reads(f.state.currentNamesFile), 2);
});

test("back navigation reuses details, but transcript appends and metadata edits invalidate them", async (t) => {
  const f = fixture(t);
  const transcript = path.join(f.dir, "Anna", "session.jsonl");
  const reads = transcriptReads(t);
  await f.run((view) => {
    view.handleInput("Anna");
    view.handleInput("\r");
    assert.equal(reads(transcript), 1);
    view.handleInput("\u001b");
    view.handleInput("\r");
    assert.equal(reads(transcript), 1);
    view.handleInput("\u001b");
    fs.appendFileSync(
      transcript,
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "new response" }] },
      }) + "\n",
    );
    view.handleInput("\r");
    assert.equal(reads(transcript), 2);
    assert.match(view.render(100).join("\n"), /new response/);
    view.handleInput("\u001b");
    f.registry.agents.Anna.intelligence = "updated";
    f.saveRegistry();
    view.handleInput("\r");
    assert.equal(reads(transcript), 3);
    assert.match(view.render(100).join("\n"), /Updated\/worker/);
  });
});

test("detail cache detects a newly selected session file and a newly created private fork", async (t) => {
  const f = fixture(t);
  f.state.currentOwnerId = "viewer";
  await f.run((view) => {
    view.handleInput("Anna");
    view.handleInput("\r");
    view.handleInput("\u001b");
    const newest = path.join(f.dir, "Anna", "new.jsonl");
    fs.writeFileSync(newest, JSON.stringify({ type: "message", message: { role: "user", content: "new session" } }));
    const future = Date.now() / 1000 + 10;
    fs.utimesSync(newest, future, future);
    view.handleInput("\r");
    assert.match(view.render(100).join("\n"), /new session/);
    view.handleInput("\u001b");
    const forkDir = path.join(f.dir, "fork");
    fs.mkdirSync(forkDir);
    fs.writeFileSync(
      path.join(forkDir, "fork.jsonl"),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "private session" },
      }),
    );
    f.registry.agents.Anna.forks.viewer = { sessionDir: forkDir, createdAt: 1 };
    f.saveRegistry();
    view.handleInput("\r");
    assert.match(view.render(100).join("\n"), /private session/);
  });
});

test("detail LRU holds eight entries and does not survive reopening the overlay", async (t) => {
  const f = fixture(
    t,
    Array.from({ length: 9 }, (_, i) => `Name${i}`),
  );
  const reads = transcriptReads(t);
  const transcript = path.join(f.dir, "Name0", "session.jsonl");
  await f.run((view) => {
    let query = "";
    const open = (name: string) => {
      for (const _char of query) view.handleInput("\u007f");
      query = name;
      view.handleInput(name);
      view.handleInput("\r");
      view.handleInput("\u001b");
    };
    for (let i = 0; i < 8; i++) open(`Name${i}`);
    open("Name0"); // Touch the oldest entry so Name1 is evicted instead.
    assert.equal(reads(transcript), 1);
    open("Name8");
    open("Name0");
    assert.equal(reads(transcript), 1);
    open("Name1");
    assert.equal(reads(path.join(f.dir, "Name1", "session.jsonl")), 2);
  });
  await f.run((view) => {
    view.handleInput("Name0");
    view.handleInput("\r");
    assert.equal(reads(transcript), 2);
  });
});

test("overlay polls fresh registry references and closes on session replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture(t);
  await f.run((view) => {
    view.handleInput("worker");
    f.registry.agents.Olga = { ...f.registry.agents.Anna, name: "Olga", createdAt: 2 };
    f.saveRegistry();
    t.mock.timers.tick(1000);
    const screen = view.render(100).join("\n");
    assert.match(screen, /Expand subagent \(2\/2\)/);
    assert.match(screen, /Search: worker/);
    assert.ok(screen.indexOf("Olga") < screen.indexOf("Anna"));
    assert.match(screen, /> Anna/);
    f.state.lifecycleGeneration++;
    t.mock.timers.tick(1000);
    assert.equal(f.doneCalls(), 1);
    t.mock.timers.tick(5000);
    assert.equal(f.doneCalls(), 1);
  });
});
