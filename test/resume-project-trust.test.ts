import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveSessionTarget } from "../runner/session-target.js";

const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const trustFlags = new Set(["--approve", "-a", "--no-approve", "-na"]);

test("resume scopes discovery, approval and process cwd to one pinned saved session", () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/resume-trust-"));
  try {
    const caller = path.join(root, "caller");
    const saved = path.join(root, "untrusted-saved-project");
    const agentDir = path.join(root, "agent");
    const sessions = path.join(caller, "sessions");
    const marker = path.join(root, "executed");
    const report = path.join(root, "report.json");
    for (const directory of [caller, saved, sessions, agentDir]) fs.mkdirSync(directory, { recursive: true });
    const write = (file: string, content: string) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    };
    const extension = (file: string) =>
      write(
        file,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'extension executed'); export default () => {};`,
      );
    const callerExtension = extension(path.join(caller, ".pi/extensions/caller.ts"));
    const savedExtension = extension(path.join(saved, ".pi/extensions/hostile.ts"));
    const globalExtension = extension(path.join(agentDir, "extensions/kept.ts"));
    const excludedExtension = extension(path.join(agentDir, "extensions/excluded.ts"));
    for (const [cwd, shellPath] of [
      [caller, "CALLER_EXECUTABLE"],
      [saved, "UNTRUSTED_EXECUTABLE"],
    ]) {
      write(path.join(cwd, ".pi/settings.json"), JSON.stringify({ shellPath, shellCommandPrefix: "UNTRUSTED_PREFIX" }));
    }
    const chosen = path.join(sessions, "chosen.jsonl");
    const newerDuringDiscovery = path.join(sessions, "other.jsonl");
    const fake = write(
      path.join(root, "fake.mjs"),
      `
      import { writeFileSync } from 'node:fs';
      process.stdin.once('data', () => {
        writeFileSync(${JSON.stringify(report)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
        console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant',
          content: [{ type: 'text', text: 'fake continuation' }], stopReason: 'stop' } }));
        console.log(JSON.stringify({ type: 'agent_settled' }));
      });
    `,
    );
    const runner = pathToFileURL(path.resolve("runner.ts")).href;
    const types = pathToFileURL(path.resolve("types.ts")).href;
    const validationSdk = process.env.PI_TEST_SDK_ROOT
      ? pathToFileURL(path.join(process.env.PI_TEST_SDK_ROOT, "dist/index.js")).href
      : import.meta.resolve("@earendil-works/pi-coding-agent");
    for (const [differentCwd, exclusions, trusted, legacyHeader] of [
      [true, true, true, false],
      [true, false, true, false],
      [false, true, true, false],
      [false, false, false, false],
      [false, false, true, true],
    ]) {
      const savedCwd = differentCwd ? saved : caller;
      write(
        chosen,
        JSON.stringify({ type: "session", id: "chosen", ...(legacyHeader ? {} : { cwd: savedCwd }) }) + "\n",
      );
      write(
        newerDuringDiscovery,
        JSON.stringify({ type: "session", id: "other", cwd: differentCwd ? caller : saved }) + "\n",
      );
      fs.utimesSync(chosen, 200, 200);
      fs.utimesSync(newerDuringDiscovery, 100, 100);
      const code = `
        // Populate inherited CLI flags before importing the runner's cached argument parser.
        process.argv = [process.execPath, 'fake-parent', '--approve'];
        const { runAgentSubprocess } = await import(${JSON.stringify(runner)});
        const { buildSubagentDetails } = await import(${JSON.stringify(types)});
        const { DefaultPackageManager } = await import('@earendil-works/pi-coding-agent');
        const { SettingsManager } = await import(${JSON.stringify(validationSdk)});
        const { parseArgs } = await import(new URL('./cli/args.js', ${JSON.stringify(validationSdk)}));
        const fs = await import('node:fs');
        let discoveries = 0;
        const changeMtime = () => fs.utimesSync(${JSON.stringify(newerDuringDiscovery)}, 300, 300);
        const resolve = DefaultPackageManager.prototype.resolve;
        DefaultPackageManager.prototype.resolve = async function(...args) {
          discoveries++;
          changeMtime(); // Force a different newest file during asynchronous extension resolution.
          return resolve.apply(this, args);
        };
        const result = await runAgentSubprocess({
          cwd: ${JSON.stringify(caller)}, projectTrusted: ${trusted},
          agents: [{ name: 'worker', description: '', source: 'builtin', filePath: '', systemPrompt: '' }],
          agentName: 'worker', task: 'continue', parentDepth: 0, parentAgentStack: [], maxDepth: 1, preventCycles: false,
          sessionDir: 'sessions', resumeSession: true, resumeSettings: { model: 'saved/model', thinking: 'high', intelligence: 'senior' },
          // Also force the race without exclusions, after the runner has emitted its pending state.
          onUpdate: changeMtime,
          makeDetails: results => buildSubagentDetails('single', 'spawn', null, results),
          piCommandOverride: { command: process.execPath, argsPrefix: [${JSON.stringify(fake)}] },
        });
        const captured = JSON.parse(fs.readFileSync(${JSON.stringify(report)}, 'utf8'));
        const approval = parseArgs(captured.args).projectTrustOverride;
        const settings = SettingsManager.create(captured.cwd, ${JSON.stringify(agentDir)}, { projectTrusted: approval });
        console.log(JSON.stringify({ ...captured, approval, discoveries, exitCode: result.exitCode, error: result.errorMessage,
          intelligence: result.intelligence, projectSettings: settings.getProjectSettings() }));
      `;
      const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: root };
      delete env["PI-SUBAGENT-EXCLUDE-EXTENSIONS"];
      delete env.PI_SUBAGENT_EXCLUDE_EXTENSIONS;
      if (exclusions) env.PI_SUBAGENT_EXCLUDE_EXTENSIONS = excludedExtension;
      const captured = JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], {
          cwd: process.cwd(),
          env,
          encoding: "utf8",
          timeout: 15000,
        }),
      );
      assert.equal(captured.exitCode, 0, captured.error);
      assert.equal(captured.cwd, savedCwd);
      assert.equal(
        flag(captured.args, "--session"),
        chosen,
        "mtime changes must not reselect a different session after discovery",
      );
      assert.equal(
        flag(captured.args, "--session-dir"),
        sessions,
        "relative session dirs are pinned before switching cwd",
      );
      assert.equal(
        captured.args.filter((arg: string) => trustFlags.has(arg)).at(-1),
        !differentCwd && trusted ? "--approve" : "--no-approve",
        "the parent's --approve cannot approve another project",
      );
      assert.equal(captured.projectSettings.shellPath, !differentCwd && trusted ? "CALLER_EXECUTABLE" : undefined);
      assert.equal(
        captured.projectSettings.shellCommandPrefix,
        !differentCwd && trusted ? "UNTRUSTED_PREFIX" : undefined,
      );
      assert.equal(captured.approval, !differentCwd && trusted, "the actual CLI parser must reject inherited approval");
      assert.equal(captured.intelligence, "senior");
      assert.equal(captured.args.includes(savedExtension), false);
      if (exclusions) {
        assert.ok(captured.discoveries > 0);
        assert.ok(captured.args.includes(globalExtension));
        assert.equal(captured.args.includes(callerExtension), !differentCwd && trusted);
        assert.equal(captured.args.includes(excludedExtension), false);
      }
      assert.equal(fs.existsSync(marker), false, "resource discovery must not execute extension code");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unusable saved headers fail before resource discovery or process launch", () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/resume-header-"));
  try {
    const file = path.join(root, "saved.jsonl");
    for (const header of [
      { type: "message", id: "not-a-header" },
      { type: "session", id: "bad-cwd", cwd: {} },
      { type: "session", id: "relative-cwd", cwd: "../ambiguous-project" },
    ]) {
      fs.writeFileSync(file, JSON.stringify(header) + "\n");
      assert.throws(() => resolveSessionTarget(root, root, true, true), /Cannot resume subagent/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
