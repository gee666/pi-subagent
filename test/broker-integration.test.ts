import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRootBroker, shutdownRootBroker } from "../broker/root.js";
import { listBrokerJobs } from "../broker/files.js";
import { createBudget, readBudget, reserveSubagentBudgets } from "../budget.js";
import { updateNamesRegistry } from "../names.js";
import { runAgentSubprocess } from "../runner.js";
import { TreeWorkerAdmission } from "../runner/tree-admission.js";
import { loadSubagentSettings } from "../settings.js";
import { createTreeConcurrencyStore } from "../storage/tree-concurrency.js";
import { buildSubagentDetails } from "../types.js";
import { settingsFixture } from "./helpers/settings.js";

type Event = {
  kind: string;
  pid: number;
  depth: number;
  name?: string;
  context?: boolean;
  content?: unknown;
  details?: {
    asyncJobId?: string;
    asyncTaskIndex?: number;
    brokerJobId?: string;
    results?: Array<{ name?: string; budget?: { directory: string } }>;
  };
};
for (const [limit, parents] of [
  [1, 1],
  [4, 4],
] as const) {
  test(
    `root file broker unloads ${parents} parents and runs two children each within resident cap ${limit}`,
    { timeout: 180000 },
    async () => {
      const f = settingsFixture();
      const previous = { root: process.env.TEST_BROKER_ROOT, children: process.env.TEST_BROKER_CHILDREN };
      process.env.TEST_BROKER_ROOT = f.root;
      process.env.TEST_BROKER_CHILDREN = "2";
      const worker = fileURLToPath(new URL("./fixtures/broker-worker.mjs", import.meta.url));
      const loader = fileURLToPath(import.meta.resolve("tsx/esm"));
      f.write(f.agent, {
        runner: { command: process.execPath, argsPrefix: ["--import", loader, worker] },
        limits: { concurrency: limit },
      });
      const settings = loadSubagentSettings(f.project, true);
      const store = createTreeConcurrencyStore({ directory: path.join(f.root, "ledger"), limit });
      const endpoint = createRootBroker(store);
      const rootBudget = createBudget(path.join(f.root, "root-budget"), parents * 3);
      const parentNames = Array.from({ length: parents }, (_, index) => `Parent-${index}`);
      const parentBudgets = reserveSubagentBudgets(
        rootBudget,
        "parents",
        parentNames.map((name) => ({ agent: "worker", task: name, max_subagents_allowed: 2 })),
      );
      const budgets: Record<string, { directory: string }> = {};
      for (const [index, name] of parentNames.entries()) {
        const children = reserveSubagentBudgets(
          parentBudgets[index],
          `children-${index}`,
          [0, 1].map((child) => ({ agent: "worker", task: `${name}-Child-${child}`, max_subagents_allowed: 0 })),
        );
        children.forEach((budget, child) => {
          budgets[`${name}-Child-${child}`] = budget;
        });
      }
      fs.writeFileSync(path.join(f.root, "budgets.json"), JSON.stringify(budgets));
      const namesFile = path.join(f.root, "names.json");
      await updateNamesRegistry(namesFile, (registry) => {
        for (const name of Object.keys(budgets))
          registry.agents[name] = {
            name,
            agent: "worker",
            task: name,
            ownerSessionId: `${name.split("-Child-")[0]}-owner`,
            sessionDir: path.join(f.root, `${name}-session`),
            budget: budgets[name],
            createdAt: Date.now(),
            forks: {},
          };
      });
      const before = [readBudget(rootBudget), ...parentBudgets.map(readBudget)];
      let maximum = 0;
      const sample = setInterval(() => {
        const resident = new Set(
          store
            .snapshot()
            .filter((entry) => store.isProcessAlive(entry))
            .map((entry) => entry.pid),
        );
        maximum = Math.max(maximum, resident.size);
      }, 5);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 150000);
      try {
        const agent = { name: "worker", description: "test", systemPrompt: "", source: "user" as const, filePath: "" };
        const runs = parentNames.map((name, index) =>
          runAgentSubprocess({
            cwd: f.project,
            settings,
            projectTrusted: true,
            agents: [agent],
            agentName: "worker",
            task: `parent-task:${name}`,
            subagentName: name,
            budget: parentBudgets[index],
            parentDepth: 0,
            parentAgentStack: [],
            maxDepth: 3,
            preventCycles: false,
            sessionDir: path.join(f.root, `${name}-session`),
            sessionRoot: f.root,
            namesFile,
            treeAdmission: new TreeWorkerAdmission(store, name, undefined, { brokerEndpoint: endpoint }),
            signal: controller.signal,
            makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
          }),
        );
        const results = await Promise.all(runs);
        for (const result of results) assert.equal(result.exitCode, 0, JSON.stringify(result));
        const events = fs
          .readFileSync(path.join(f.root, "events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Event);
        const children = events.filter((event) => event.kind === "initial-prompt" && event.depth === 2);
        assert.equal(children.length, parents * 2, "each child runs once, never re-submitted by restored recovery");
        const completions = events.filter((event) => event.kind === "completion");
        assert.equal(completions.length, parents * 2, "every durable child result is consumed exactly once");
        assert.equal(new Set(completions.map((event) => event.details?.brokerJobId)).size, parents * 2);
        for (const event of completions) {
          assert.equal(event.details?.asyncJobId, "original-nested-call");
          assert.ok(event.details?.asyncTaskIndex === 0 || event.details?.asyncTaskIndex === 1);
          const child = event.details?.results?.[0];
          assert.equal(child?.budget?.directory, budgets[child!.name!].directory);
        }
        const restored = events.filter((event) => event.kind === "restored");
        assert.ok(restored.length >= parents);
        assert.ok(
          restored.every((event) => event.context === true),
          "parked parent session context must survive unloading",
        );
        assert.ok(
          events
            .filter((event) => event.kind === "queued-message")
            // Earlier parents may already have parked, allowing immediate delivery.
            .every((event) => /Message (queued for|sent to) subagent/.test(JSON.stringify(event.content))),
        );
        assert.equal(events.filter((event) => event.kind === "steer" && event.depth === 2).length, parents);
        assert.ok(maximum <= limit, `${maximum} resident workers exceeded hard cap ${limit}`);
        assert.equal(listBrokerJobs(endpoint).length, parents * 2);
        assert.deepEqual(
          [readBudget(rootBudget), ...parentBudgets.map(readBudget)],
          before,
          "parking and mailbox restoration cannot reserve a new budget",
        );
      } finally {
        clearTimeout(timer);
        clearInterval(sample);
        controller.abort();
        await shutdownRootBroker(endpoint);
        if (previous.root === undefined) delete process.env.TEST_BROKER_ROOT;
        else process.env.TEST_BROKER_ROOT = previous.root;
        if (previous.children === undefined) delete process.env.TEST_BROKER_CHILDREN;
        else process.env.TEST_BROKER_CHILDREN = previous.children;
        f.close();
      }
    },
  );
}
