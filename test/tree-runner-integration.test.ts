import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createTreeConcurrencyStore } from "../storage/tree-concurrency.js";
import { WorkerScheduler } from "../runner/worker-scheduler.js";
import { runAgentSubprocess } from "../runner/single.js";
import { createRootBroker, shutdownRootBroker } from "../broker/root.js";
import { listBrokerJobs } from "../broker/files.js";
import { buildSubagentDetails } from "../types.js";
import { until } from "./helpers/message-subagent.js";

const agent = { name: "worker", description: "test", systemPrompt: "", source: "builtin" as const, filePath: "" };
const moduleUrl = (file: string) => pathToFileURL(path.resolve(file)).href;
for (const limit of [1, 2]) {
  test(
    `root broker preserves two nested jobs across parent unloading at cap ${limit}`,
    { timeout: 15000 },
    async () => {
      fs.mkdirSync("tmp", { recursive: true });
      const root = fs.mkdtempSync(path.resolve("tmp/tree-runner-"));
      const store = createTreeConcurrencyStore({ directory: path.join(root, "ledger"), limit });
      const endpoint = createRootBroker(store);
      const scheduler = new WorkerScheduler(limit, { store, root: true, brokerEndpoint: endpoint });
      const leafLog = path.join(root, "leaves.jsonl"),
        parentLog = path.join(root, "parents.jsonl");
      const sessionDir = path.join(root, "parent-session");
      const leaf = `
      const fs=require('node:fs');
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const name=JSON.parse(line).message.includes('first')?'first':'second';
        fs.appendFileSync(${JSON.stringify(leafLog)},JSON.stringify({name,pid:process.pid})+'\\n');
        const timer=setInterval(()=>{
          if(!fs.existsSync(${JSON.stringify(root)}+'/release-'+name))return;clearInterval(timer);
          console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:name+' done'}],stopReason:'stop'}}));
          console.log(JSON.stringify({type:'agent_settled'}));
        },10);
      });
    `;
      const child = `
      import fs from 'node:fs';
      import {createExtensionState} from ${JSON.stringify(moduleUrl("extension/state.ts"))};
      import {schedulerFor} from ${JSON.stringify(moduleUrl("extension/scheduler.ts"))};
      import {submitBrokerJob,pendingBrokerJobs,watchBrokerJob} from ${JSON.stringify(moduleUrl("broker/files.ts"))};
      import readline from 'node:readline';
      const state=createExtensionState({getFlag:()=>undefined});state.settings={PI_SUBAGENT_MAX_CONCURRENCY:'99'};
      const scheduler=schedulerFor(state),endpoint=scheduler.brokerEndpoint,ownerToken=process.env.PI_SUBAGENT_WORKER_TOKEN;
      const emit=event=>console.log(JSON.stringify(event));
      readline.createInterface({input:process.stdin}).on('line',async line=>{
        if(JSON.parse(line).type!=='prompt')return;
        fs.mkdirSync(${JSON.stringify(sessionDir)},{recursive:true});
        const session=${JSON.stringify(path.join(sessionDir, "session.jsonl"))};
        if(!fs.existsSync(session))fs.writeFileSync(session,JSON.stringify({type:'session',id:'broker-parent',cwd:${JSON.stringify(root)}})+'\\n');
        fs.appendFileSync(${JSON.stringify(parentLog)},JSON.stringify({pid:process.pid,token:ownerToken})+'\\n');
        let jobs=pendingBrokerJobs(endpoint,ownerToken);
        let futures;
        if(!jobs.length){
          futures=['first','second'].map((name,index)=>scheduler.scheduleRemote('leaf-'+name,(signal,admission)=>{
            const receipt=submitBrokerJob(endpoint,{
              ownerToken,ownerId:'saved-owner',toolCallId:'nested-work',taskIndex:index,name:'leaf-'+name,
              agents:[${JSON.stringify(agent)}],task:{agent:'worker',task:name},cwd:${JSON.stringify(root)},
              settings:{PI_SUBAGENT_PI_COMMAND:process.execPath,PI_SUBAGENT_PI_ARGS_PREFIX:${JSON.stringify(JSON.stringify(["-e", leaf, "--"]))}},
              projectTrusted:true,parentDepth:1,maxDepth:5,parentAgentStack:[],preventCycles:false,
              sessionDir:${JSON.stringify(root)}+'/leaf-'+name,sessionRoot:${JSON.stringify(root)},namesFile:'',resumeSession:false,
            },admission.token);
            return watchBrokerJob(endpoint,receipt.id,signal);
          }).promise);
        }else futures=jobs.map(spec=>watchBrokerJob(endpoint,spec.id));
        emit({type:'subagent_background',running:futures.length});emit({type:'agent_settled'});
        const results=await Promise.all(futures);
        emit({type:'subagent_background',running:0});emit({type:'turn_start'});
        emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'root cap '+scheduler.concurrency+': '+results.map(result=>result.finalOutput||result.errorMessage).join(', ')}],stopReason:'stop'}});
        emit({type:'agent_settled'});
      });
    `;
      const operation = scheduler.schedule("parent", (signal, treeAdmission) =>
        runAgentSubprocess({
          cwd: root,
          agents: [agent],
          agentName: "worker",
          task: "delegate",
          parentDepth: 0,
          maxDepth: 5,
          parentAgentStack: [],
          preventCycles: false,
          signal,
          treeAdmission,
          sessionDir,
          piCommandOverride: {
            command: process.execPath,
            argsPrefix: ["--import", "tsx/esm", "--input-type=module", "-e", child, "--"],
          },
          startupTimeoutMsOverride: 10000,
          makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
        }),
      );
      const rows = (file: string): Array<{ name?: string; pid: number; token?: string }> =>
        fs.existsSync(file)
          ? fs
              .readFileSync(file, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
          : [];
      let maximum = 0;
      const sampler = setInterval(() => {
        maximum = Math.max(
          maximum,
          store.snapshot().filter((entry) => entry.pid && store.isProcessAlive(entry)).length,
        );
      }, 5);
      try {
        await until(() => rows(leafLog).length >= 1);
        assert.equal(store.getLimit(), limit, "nested settings cannot raise the root memory cap");
        fs.writeFileSync(path.join(root, "release-first"), "done");
        await until(() => rows(leafLog).length === 2);
        fs.writeFileSync(path.join(root, "release-second"), "done");
        const result = await operation.promise;
        assert.equal(result.exitCode, 0);
        assert.match(JSON.stringify(result.messages), /first done/);
        assert.match(JSON.stringify(result.messages), /second done/);
        assert.deepEqual(
          rows(leafLog)
            .map((entry) => entry.name)
            .sort(),
          ["first", "second"],
        );
        assert.equal(
          listBrokerJobs(endpoint).length,
          2,
          "restart reconnects durable jobs instead of duplicating children",
        );
        const attempts = rows(parentLog);
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0].token, attempts[1].token);
        assert.notEqual(attempts[0].pid, attempts[1].pid);
        assert.ok(maximum <= limit, `observed ${maximum} physical workers above cap ${limit}`);
        assert.ok(
          store
            .snapshot()
            .filter((entry) => entry.name.startsWith("leaf-"))
            .every((entry) => entry.ownerPid === process.pid),
        );
      } finally {
        clearInterval(sampler);
        fs.writeFileSync(path.join(root, "release-first"), "done");
        fs.writeFileSync(path.join(root, "release-second"), "done");
        scheduler.shutdown();
        await operation.promise.catch(() => undefined);
        await shutdownRootBroker(endpoint);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
