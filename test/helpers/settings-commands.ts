import assert from "node:assert/strict";
import * as path from "node:path";
import type { ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createExtensionHarness, hostDouble } from "./extension.js";
import { settingsFixture } from "./settings.js";

export function setup(overrides: Record<string, unknown> = {}) {
  const f = settingsFixture();
  f.write(f.agent, { resume: { disableAuto: true }, ...overrides });
  process.env.PI_SUBAGENT_SESSION_ROOT = path.join(f.root, "sessions");
  const host = createExtensionHarness();
  const entries: SessionEntry[] = [];
  const notifications: string[] = [];
  const selections: string[] = [];
  const base = host.makeCtx(entries, { cwd: f.project });
  const ctx = hostDouble<ExtensionCommandContext>({
    ...base,
    ui: {
      ...base.ui,
      notify: (text: string) => {
        notifications.push(text);
      },
      select: async (title: string) => {
        selections.push(title);
        return "project";
      },
    },
  });
  return {
    f,
    host,
    entries,
    ctx,
    notifications,
    selections,
    async command(name: string, args = "") {
      const command = host.commands.get(`subagent:${name}`);
      assert.ok(command, name);
      await command.handler(args, ctx);
    },
  };
}
