import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fauxAssistantMessage, normalizeContext } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createBudget, readBudget, SUBAGENT_BUDGET_CUSTOM_TYPE } from "../budget.js";
import { findPersistedNamesIdentity, readNamesRegistry } from "../names.js";
import { findLatestResumableSubagentCalls } from "../resume.js";
import { RESUME_MODEL_ID, RESUME_PROVIDER } from "../shared.js";
import { createExtensionHarness, customEntry, hostDouble, messageEntry, model } from "./helpers/extension.js";
import { serializedDetails } from "./helpers/json.js";
import { until } from "./helpers/message-subagent.js";
import { settingsFixture } from "./helpers/settings.js";

type Run = {
  args: string[];
  session: string;
  ledger: string;
  token: string;
  broker: string;
  secret: string;
  budget: string;
};

test(
  "graceful root reopen recovers saved work with fresh broker generation and reuses budget/name/session",
  { timeout: 20000 },
  async () => {
    const f = settingsFixture();
    const log = path.join(f.root, "runs.jsonl"),
      gate = path.join(f.root, "finish");
    const script = path.join(f.root, "worker.cjs");
    fs.writeFileSync(
      script,
      `
    const fs=require('node:fs'),path=require('node:path');
    const args=process.argv.slice(2),flag=k=>args[args.indexOf(k)+1];
    const session=args.includes('--session')?flag('--session'):path.join(flag('--session-dir'),'session.jsonl');
    fs.mkdirSync(path.dirname(session),{recursive:true});
    if(!fs.existsSync(session))fs.writeFileSync(session,JSON.stringify({type:'session',version:3,id:'saved-worker',cwd:process.cwd(),timestamp:new Date().toISOString()})+'\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line);if(request.type!=='prompt')return;
      fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,session,ledger:process.env.PI_SUBAGENT_CONCURRENCY_DIR,
        token:process.env.PI_SUBAGENT_WORKER_TOKEN,broker:process.env.PI_SUBAGENT_BROKER_DIR,
        secret:process.env.PI_SUBAGENT_BROKER_SECRET,budget:process.env.PI_SUBAGENT_BUDGET_DIR})+'\\n');
      console.log(JSON.stringify({type:'response',command:'prompt',id:request.id,success:true}));
      console.log(JSON.stringify({type:'turn_start'}));
      const timer=setInterval(()=>{
        if(!fs.existsSync(${JSON.stringify(gate)}))return;
        clearInterval(timer);
        console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'saved work continued'}],stopReason:'stop'}}));
        console.log(JSON.stringify({type:'agent_settled'}));
      },10);
    });
  `,
    );
    f.write(f.agent, {
      runner: { command: process.execPath, argsPrefix: [script] },
      limits: { concurrency: 1 },
      resume: { prompt: false },
    });
    const budget = createBudget(path.join(f.root, "root-budget"), 10);
    const entries: SessionEntry[] = [customEntry(SUBAGENT_BUDGET_CUSTOM_TYPE, budget)];
    const context = (host: ReturnType<typeof createExtensionHarness>, id: string) =>
      host.makeCtx(entries, {
        cwd: f.project,
        hasUI: false,
        isProjectTrusted: () => true,
        sessionManager: hostDouble<ExtensionContext["sessionManager"]>({
          getEntries: () => entries,
          getBranch: () => entries,
          getLeafId: () => entries.at(-1)?.id ?? null,
          getSessionId: () => id,
          getSessionDir: () => path.join(f.root, "sessions"),
          getHeader: () => null,
          getSessionFile: () => undefined,
        }),
      });
    const first = createExtensionHarness(),
      firstCtx = context(first, "original-root");
    const reopened = createExtensionHarness();
    let reopenedCtx: ExtensionContext | undefined;
    const runs = (): Run[] =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Run)
        : [];
    try {
      await first.emit("session_start", {}, firstCtx);
      const tasks = [{ task: "unfinished work", max_subagents_allowed: 2 }];
      entries.push(
        messageEntry(
          fauxAssistantMessage({ type: "toolCall", id: "original-launch", name: "subagents", arguments: { tasks } }),
          "launch",
        ),
      );
      const receipt = await first.call("subagents", "original-launch", { tasks }, firstCtx);
      assert.equal(receipt.isError, false, JSON.stringify(receipt.content));
      entries.push(
        messageEntry(
          {
            role: "toolResult",
            toolName: "subagents",
            toolCallId: "original-launch",
            content: receipt.content,
            details: serializedDetails(receipt.details),
            isError: false,
            timestamp: Date.now(),
          },
          "receipt",
        ),
      );
      await until(() => runs().length === 1);
      const original = runs()[0],
        before = readBudget(budget);
      const namesFile = findPersistedNamesIdentity(entries)!.namesFile;
      const namesBefore = Object.keys(readNamesRegistry(namesFile).agents);
      await first.emit("session_shutdown", {}, firstCtx);
      assert.equal(
        findLatestResumableSubagentCalls(firstCtx).length,
        1,
        "graceful close is not an intentional worker stop",
      );

      // A new depth-zero root must not adopt stale metadata from a previous generation.
      Object.assign(process.env, {
        PI_SUBAGENT_CONCURRENCY_DIR: original.ledger,
        PI_SUBAGENT_WORKER_TOKEN: original.token,
        PI_SUBAGENT_BROKER_DIR: original.broker,
        PI_SUBAGENT_BROKER_SECRET: original.secret,
      });
      reopenedCtx = context(reopened, "reopened-root");
      await reopened.emit("session_start", { reason: "resume" }, reopenedCtx);
      assert.equal(reopened.calls.confirms, 0);
      assert.ok(reopened.calls.setModel.some((value) => value.provider === RESUME_PROVIDER));
      const response = await reopened
        .provider(RESUME_PROVIDER)
        .streamSimple(
          model(RESUME_PROVIDER, RESUME_MODEL_ID, "openai-responses"),
          normalizeContext({
            messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }],
          }),
          {},
        )
        .result();
      const call = response.content.find((part) => part.type === "toolCall");
      assert.ok(call?.type === "toolCall");
      fs.writeFileSync(gate, "finish");
      const recovered = await reopened.callAndWait("subagents", call.id, call.arguments, reopenedCtx);
      assert.equal(recovered.isError, false, JSON.stringify(recovered.content));
      assert.equal(runs().length, 2, "one recovery, no duplicate worker launch");
      const resumed = runs()[1];
      assert.ok(resumed.args.includes("--session"));
      assert.equal(resumed.session, original.session);
      assert.equal(resumed.budget, original.budget);
      assert.notEqual(resumed.ledger, original.ledger);
      assert.notEqual(resumed.token, original.token);
      assert.notEqual(resumed.broker, original.broker);
      assert.notEqual(resumed.secret, original.secret);
      assert.equal(recovered.details.results[0].name, receipt.details.results[0].name);
      assert.deepEqual(readBudget(budget), before, "recovery reuses the original reservation key");
      assert.deepEqual(Object.keys(readNamesRegistry(namesFile).agents), namesBefore);
    } finally {
      if (reopenedCtx) await reopened.emit("session_shutdown", {}, reopenedCtx);
      await first.emit("session_shutdown", {}, firstCtx);
      f.close();
    }
  },
);
