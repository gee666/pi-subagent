import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerStopSubagentTool } from "../extension/stop-tool.js";
import { readBudget } from "../budget.js";
import { fixture, text } from "./helpers/message-subagent.js";
import { simulatedTreeWorker } from "./helpers/tree-concurrency.js";

for (const relation of ["ancestor", "sibling", "grandchild"] as const) {
  test(`message and stop reject a ${relation} even with a matching saved owner`, async () => {
    const f = await fixture();
    const tree = simulatedTreeWorker(path.join(f.root, "concurrency"), relation === "ancestor" ? f.name : "Ancestor");
    try {
      const admit = (name: string, parentToken: string) => {
        const token = tree.store.enqueue(name, parentToken);
        assert.equal(tree.store.claim(token), "running");
        tree.store.bindPid(token, process.pid);
        return token;
      };
      const caller = admit("Caller", tree.token);
      const target =
        relation === "ancestor"
          ? tree.token
          : relation === "sibling"
            ? admit(f.name, tree.token)
            : admit(f.name, admit("Direct-child", caller));
      Object.assign(process.env, { ...tree.env, PI_SUBAGENT_WORKER_TOKEN: caller });
      f.state.currentDepth = 1;
      const received: string[] = [];
      f.running((message) => {
        received.push(message);
        return true;
      });
      const before = readBudget(f.budget);
      const message = await f.execute({ name: f.name, message: "unauthorized", max_subagents_allowed: 3 });
      assert.equal(Reflect.get(message, "isError"), true);
      assert.match(text(message), /not your direct child/);
      assert.deepEqual(received, []);
      assert.deepEqual(readBudget(f.budget), before);
      let stop: ToolDefinition | undefined;
      const register = f.state.pi.registerTool;
      f.state.pi.registerTool = (tool) => {
        stop = tool as unknown as ToolDefinition;
      };
      registerStopSubagentTool(f.state);
      f.state.pi.registerTool = register;
      assert.ok(stop);
      const stopped = await stop.execute("denied-stop", { name: f.name }, undefined, undefined, f.ctx);
      assert.equal(Reflect.get(stopped, "isError"), true);
      assert.match(text(stopped), /not your direct child/);
      assert.equal(tree.store.get(target)?.status, "running");
      assert.equal(tree.store.get(caller)?.status, "running");
      assert.equal(f.state.backgroundJobs.size, 0);
    } finally {
      tree.close();
      await f.close();
    }
  });
}
