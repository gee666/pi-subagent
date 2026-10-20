import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTreeConcurrencyStore, matchesProcess } from "../storage/tree-concurrency.js";
import { WorkerScheduler } from "../runner/worker-scheduler.js";
import { createRootBroker, shutdownRootBroker } from "../broker/root.js";
import { runAgentSubprocess } from "../runner/single.js";
import { buildSubagentDetails, buildLiveSubagentDetails, type SingleResult } from "../types.js";
import type { DetailsFactory } from "../runner/options.js";
import type { WorkerTicket } from "../runner/worker-scheduler.js";
import { createBudget } from "../budget.js";
import { until } from "./helpers/message-subagent.js";

const agent = { name: "worker", description: "test", systemPrompt: "", source: "builtin" as const, filePath: "" };
const makeDetails: DetailsFactory = (results) => buildSubagentDetails("single", "spawn", null, results);
makeDetails.live = (results) => buildLiveSubagentDetails("single", "spawn", null, results);
for (const limit of [1, 2]) {
  test(`parent unloading preserves its future and session under hard cap ${limit}`, { timeout: 15000 }, async () => {
    fs.mkdirSync("tmp", { recursive: true });
    const root = fs.mkdtempSync(path.resolve("tmp/parent-parking-"));
    const sessionDir = path.join(root, "parent-session");
    const store = createTreeConcurrencyStore({ directory: path.join(root, "ledger"), limit });
    const endpoint = createRootBroker(store);
    const scheduler = new WorkerScheduler(limit, { store, root: true, brokerEndpoint: endpoint });
    const parentLog = path.join(root, "parents.jsonl"),
      childLog = path.join(root, "children.jsonl");
    const secondDone = path.join(root, "second-done");
    const budget = createBudget(path.join(root, "budget"), 2);
    const parentScript = `
      const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(1);
      const emit=event=>console.log(JSON.stringify(event));
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const prompt=JSON.parse(line).message;
        fs.mkdirSync(${JSON.stringify(sessionDir)},{recursive:true});
        const session=${JSON.stringify(path.join(sessionDir, "session.jsonl"))};
        if(!fs.existsSync(session))fs.writeFileSync(session,JSON.stringify({type:'session',id:'saved-parent',cwd:${JSON.stringify(root)}})+'\\n');
        const resumed=args.includes('--session');
        fs.appendFileSync(${JSON.stringify(parentLog)},JSON.stringify({pid:process.pid,token:process.env.PI_SUBAGENT_WORKER_TOKEN,prompt,resumed,budget:process.env.PI_SUBAGENT_BUDGET_DIR})+'\\n');
        if(!resumed){
          emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'waiting'}],stopReason:'stop',usage:{input:2,cost:{total:1}}}});
          emit({type:'subagent_background',running:2});emit({type:'agent_settled'});return;
        }
        emit({type:'subagent_background',running:1});
        emit({type:'agent_settled'});
        const timer=setInterval(()=>{
          if(!fs.existsSync(${JSON.stringify(secondDone)}))return;clearInterval(timer);
          emit({type:'subagent_background',running:0});emit({type:'turn_start'});
          emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'children complete'}],stopReason:'stop',usage:{input:3,cost:{total:2}}}});
          emit({type:'agent_settled'});
        },10);
      });
    `;
    const common = {
      cwd: root,
      agents: [agent],
      agentName: "worker",
      parentDepth: 0,
      maxDepth: 5,
      parentAgentStack: [],
      preventCycles: false,
      makeDetails,
    };
    let parkedUpdates = 0,
      parentSettled = false,
      maximum = 0;
    const operation = scheduler.schedule("parent", (signal, treeAdmission) =>
      runAgentSubprocess({
        ...common,
        signal,
        treeAdmission,
        task: "original task",
        subagentName: "parent",
        budget,
        sessionDir,
        piCommandOverride: { command: process.execPath, argsPrefix: ["-e", parentScript, "--"] },
        onUpdate: (update) => {
          if (update.details.results[0].parked) parkedUpdates++;
        },
      }),
    );
    void operation.promise.then(() => {
      parentSettled = true;
    });
    const rows = (
      file: string,
    ): Array<{ pid: number; token: string; prompt: string; resumed: boolean; budget: string }> =>
      fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    const sampler = setInterval(() => {
      maximum = Math.max(maximum, store.snapshot().filter((entry) => entry.pid && store.isProcessAlive(entry)).length);
    }, 5);
    let children: WorkerScheduler | undefined;
    const childJobs: Array<WorkerTicket<SingleResult>> = [];
    try {
      await until(() => rows(parentLog).length === 1);
      const parentToken = rows(parentLog)[0].token;
      const originalPid = rows(parentLog)[0].pid;
      children = new WorkerScheduler(limit, { store, parentToken, brokerEndpoint: endpoint });
      const child = (name: string) =>
        children!.schedule(name, (signal, treeAdmission) =>
          runAgentSubprocess({
            ...common,
            signal,
            treeAdmission,
            task: name,
            parentDepth: 1,
            piCommandOverride: {
              command: process.execPath,
              argsPrefix: [
                "-e",
                `
          const fs=require('node:fs');const emit=event=>console.log(JSON.stringify(event));
          require('node:readline').createInterface({input:process.stdin}).on('line',()=>{
            fs.appendFileSync(${JSON.stringify(childLog)},JSON.stringify({name:${JSON.stringify(name)},pid:process.pid})+'\\n');
            const timer=setInterval(()=>{
              if(!fs.existsSync(${JSON.stringify(path.join(root, `release-${name}`))}))return;clearInterval(timer);
              ${name === "second" ? `fs.writeFileSync(${JSON.stringify(secondDone)},'done');` : ""}
              emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop'}});emit({type:'agent_settled'});
            },10);
          });
        `,
                "--",
              ],
            },
          }),
        );
      const first = child("first"),
        second = child("second");
      childJobs.push(first, second);
      await until(() => parkedUpdates > 0);
      assert.equal(
        matchesProcess(originalPid),
        false,
        "parked parent must actually exit, not retain memory under SIGSTOP",
      );
      assert.equal(parentSettled, false, "parking is not a logical worker completion");
      await until(() => rows(childLog).length >= (limit === 1 ? 1 : 2));
      assert.equal(rows(parentLog).length, 1);
      fs.writeFileSync(path.join(root, "release-first"), "done");
      await first.promise;
      await until(() => rows(childLog).length === 2);
      if (limit === 1) {
        await new Promise((resolve) => setTimeout(resolve, 70));
        assert.equal(rows(parentLog).length, 1, "runnable children outrank the parent wake");
      } else {
        await until(() => rows(parentLog).length === 2);
        assert.equal(fs.existsSync(secondDone), false, "parent may wake early only when spare capacity exists");
      }
      fs.writeFileSync(path.join(root, "release-second"), "done");
      await second.promise;
      const result = await operation.promise;
      assert.equal(result.exitCode, 0);
      assert.equal(result.parked, false);
      assert.equal(result.budget?.directory, budget.directory);
      assert.equal(result.usage.cost, 3);
      const attempts = rows(parentLog);
      assert.equal(attempts.length, 2);
      assert.notEqual(attempts[0].pid, attempts[1].pid);
      assert.equal(attempts[0].token, attempts[1].token, "logical parent token survives parking");
      assert.equal(attempts[1].resumed, true);
      assert.match(attempts[1].prompt, /saved session is restored/);
      assert.doesNotMatch(attempts[1].prompt, /^original task/);
      assert.ok(maximum <= limit, `observed ${maximum} live worker PIDs above cap ${limit}`);
    } finally {
      clearInterval(sampler);
      fs.writeFileSync(path.join(root, "release-first"), "done");
      fs.writeFileSync(path.join(root, "release-second"), "done");
      children?.shutdown();
      scheduler.shutdown();
      await Promise.allSettled([operation.promise, ...childJobs.map((job) => job.promise)]);
      await shutdownRootBroker(endpoint);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
