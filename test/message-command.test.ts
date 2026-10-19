import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import subagentExtension from "../index.js";
import { decodeNestedBroadcast, updateLatestBroadcastTargets } from "../extension/broadcast.js";
import { registerMessageSubagentCommand } from "../extension/message-command.js";
import { createExtensionState } from "../extension/state.js";
import { buildLiveSubagentDetails } from "../types.js";
import { hostDouble } from "./helpers/extension.js";
import { makeRunningResult } from "./helpers/results.js";

type Command = Omit<RegisteredCommand, "name" | "sourceInfo">;

function fixture(choice: string | undefined = "All", answers: Array<string | undefined> = ["human message"]) {
  let command: Command | undefined;
  const pi = hostDouble<ExtensionAPI>({
    getFlag: () => undefined,
    registerCommand(name, value) {
      assert.equal(name, "message_subagent");
      command = value;
    },
  });
  const state = createExtensionState(pi);
  state.disabled = false;
  const sent: Array<{ id: number; message: string }> = [];
  const dialogs: string[] = [];
  const notices: Array<{ message: string; type: string | undefined }> = [];
  const ctx = hostDouble<ExtensionCommandContext>({
    hasUI: true,
    mode: "tui",
    ui: hostDouble<ExtensionCommandContext["ui"]>({
      select: async (title, options) => {
        dialogs.push(title);
        assert.deepEqual(options, ["All (+nested)", "All", "Youngest", "Names (e.g. John, Maria)"]);
        return choice;
      },
      input: async (title) => {
        dialogs.push(title);
        return answers.shift();
      },
      notify: (message, type) => notices.push({ message, type }),
    }),
  });
  const add = (id: number, name: string) => {
    state.activeSubagents.set(id, {
      agent: "worker",
      task: "work",
      name,
      handle: {
        steer: (message) => {
          sent.push({ id, message });
        },
      },
    });
  };
  add(10, "John");
  add(20, "Ada");
  const nested = makeRunningResult({
    name: "John",
    liveNestedSubagents: {
      children: buildLiveSubagentDetails("single", "spawn", null, [makeRunningResult({ name: "Maria" })]),
    },
  });
  updateLatestBroadcastTargets(state, buildLiveSubagentDetails("single", "spawn", null, [nested]), 10);
  registerMessageSubagentCommand(state);
  assert.ok(command);
  return { state, ctx, sent, dialogs, notices, add, run: () => command!.handler("", ctx) };
}

test("/message_subagent is registered by the extension entry point", () => {
  const commands: string[] = [];
  subagentExtension(
    hostDouble<ExtensionAPI>({
      registerFlag() {},
      getFlag: () => undefined,
      on: () => () => {},
      registerProvider() {},
      registerTool() {},
      registerCommand: (name) => {
        commands.push(name);
      },
    }),
  );
  assert.ok(commands.includes("message_subagent"));
});

test("All selects immediate children before asking for the message", async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.dialogs[0], "Message subagents");
  assert.match(f.dialogs[1], /^Message to John, Ada$/);
  assert.deepEqual(f.sent, [
    { id: 10, message: "human message" },
    { id: 20, message: "human message" },
  ]);
});

test("All (+nested) sends to roots and nested targets", async () => {
  const f = fixture("All (+nested)");
  await f.run();
  assert.equal(f.sent.length, 3);
  assert.deepEqual(
    f.sent.filter(({ message }) => !decodeNestedBroadcast(message)),
    [
      { id: 20, message: "human message" },
      { id: 10, message: "human message" },
    ],
  );
  const encoded = f.sent.find(({ message }) => decodeNestedBroadcast(message));
  assert.equal(encoded?.id, 10);
  assert.deepEqual(decodeNestedBroadcast(encoded!.message), { path: ["Maria"], message: "human message" });
});

test("Youngest means running leaves, not their running ancestors", async () => {
  const f = fixture("Youngest");
  await f.run();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].id, 20);
  assert.deepEqual(decodeNestedBroadcast(f.sent[1].message), { path: ["Maria"], message: "human message" });
});

test("Names accepts case-insensitive leaves and paths, deduplicates, and warns for unknown names", async () => {
  const f = fixture("Names (e.g. John, Maria)", ["maria, John > Maria, ADA, missing", "  exact message  "]);
  await f.run();
  assert.deepEqual(f.dialogs.slice(0, 2), ["Message subagents", "Subagent names (comma-separated)"]);
  assert.match(f.dialogs[2], /John > Maria, Ada/);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(decodeNestedBroadcast(f.sent[0].message), { path: ["Maria"], message: "  exact message  " });
  assert.equal(f.sent[1].message, "  exact message  ");
  assert.ok(f.notices.some(({ message, type }) => type === "warning" && message.includes('"missing"')));
});

test("Names ALL retains the existing all-including-nested shorthand", async () => {
  const f = fixture("Names (e.g. John, Maria)", ["ALL", "message"]);
  await f.run();
  assert.equal(f.sent.length, 3);
});

for (const [label, choice, answers, count] of [
  ["recipient selection", undefined, [], 1],
  ["name entry", "Names (e.g. John, Maria)", [undefined], 2],
  ["message entry", "All", [undefined], 2],
  ["blank message", "All", [" \n "], 2],
  ["blank names", "Names (e.g. John, Maria)", ["  "], 2],
  ["unknown names", "Names (e.g. John, Maria)", ["missing"], 2],
] as const) {
  test(`canceling ${label} sends nothing and never falls through to the lead`, async () => {
    // Pass undefined explicitly after fixture's default has been applied.
    const f = fixture(choice ?? "cancel", [...answers]);
    if (choice === undefined)
      f.ctx.ui.select = async () => {
        f.dialogs.push("Message subagents");
        return undefined;
      };
    await f.run();
    assert.equal(f.sent.length, 0);
    assert.equal(f.dialogs.length, count);
  });
}

test("no running children, disabled sessions, and missing UI do not open dialogs", async () => {
  for (const reason of ["empty", "disabled", "no-ui"] as const) {
    const f = fixture();
    if (reason === "empty") f.state.activeSubagents.clear();
    if (reason === "disabled") f.state.disabled = true;
    if (reason === "no-ui") f.ctx.hasUI = false;
    await f.run();
    assert.deepEqual(f.dialogs, []);
    assert.deepEqual(f.sent, []);
  }
});

test("RPC uses the same built-in dialogs even while the lead is streaming", async () => {
  const f = fixture();
  f.ctx.mode = "rpc";
  // The strict context double has no waitForIdle or isIdle method.
  await f.run();
  assert.equal(f.sent.length, 2);
});

test("selection stays fixed while composing; finished targets are warned about, not replaced", async () => {
  const f = fixture();
  f.ctx.ui.input = async () => {
    f.state.activeSubagents.delete(10);
    f.add(30, "New");
    return "message";
  };
  await f.run();
  assert.deepEqual(f.sent, [{ id: 20, message: "message" }]);
  assert.ok(f.notices.some(({ message }) => /no longer running: John/.test(message)));
});

test("all selected targets finishing before composition sends nothing", async () => {
  const f = fixture("Youngest");
  f.ctx.ui.select = async () => {
    f.state.activeSubagents.clear();
    return "Youngest";
  };
  await f.run();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.dialogs, []);
  assert.ok(f.notices.some(({ message }) => message === "No valid running subagents selected."));
});

for (const step of ["selection", "names", "message"] as const) {
  test(`session replacement during ${step} cancels the command`, async () => {
    const f = fixture(step === "names" ? "Names (e.g. John, Maria)" : "All");
    if (step === "selection") {
      f.ctx.ui.select = async () => {
        f.state.lifecycleGeneration++;
        return "All";
      };
    } else {
      f.ctx.ui.input = async () => {
        f.state.lifecycleGeneration++;
        return "John";
      };
    }
    await f.run();
    assert.deepEqual(f.sent, []);
  });
}
