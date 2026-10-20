import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { runAgentSubprocess } from "../runner.js";
import { buildSubagentDetails } from "../types.js";
import { settingsFixture } from "./helpers/settings.js";

test("a resumed parent queues its startup prompt as steer when restoration is already processing", async () => {
  const f = settingsFixture();
  try {
    const sessionDir = path.join(f.root, "saved-parent");
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(
      path.join(sessionDir, "session.jsonl"),
      JSON.stringify({ type: "session", id: "parent", cwd: f.project }) + "\n",
    );
    const log = path.join(f.root, "requests.jsonl");
    const script = `
      const fs = require('node:fs');
      const emit = event => console.log(JSON.stringify(event));
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        const request = JSON.parse(line);
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({request,args:process.argv})+'\\n');
        if (request.streamingBehavior !== 'steer') {
          emit({type:'response',command:'prompt',id:request.id,success:false,
            error:"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."});
          return;
        }
        emit({type:'response',command:'prompt',id:request.id,success:true});
        emit({type:'turn_start'});
        emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'resumed safely'}],stopReason:'stop'}});
        emit({type:'agent_settled'});
      });`;
    const result = await runAgentSubprocess({
      cwd: f.project,
      agents: [{ name: "worker", description: "test", systemPrompt: "", source: "user", filePath: "" }],
      agentName: "worker",
      task: "continue after restoring children",
      parentDepth: 0,
      maxDepth: 3,
      parentAgentStack: [],
      preventCycles: true,
      sessionDir,
      resumeSession: true,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
      piCommandOverride: { command: process.execPath, argsPrefix: ["-e", script, "--"] },
      startupTimeoutMsOverride: 1000,
      idleTimeoutMsOverride: 1000,
      terminationTimeoutMsOverride: 100,
    });
    assert.equal(result.exitCode, 0, result.errorMessage);
    assert.doesNotMatch(result.stderr, /already processing|prompt rejected/);
    const record = JSON.parse(fs.readFileSync(log, "utf8").trim());
    assert.equal(record.request.streamingBehavior, "steer");
    assert.equal(record.args.includes("--session"), true);
  } finally {
    f.close();
  }
});
