import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveInheritedResource } from "../runner/resource-paths.js";

const values = (args: string[], flag: string) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));

test("inherited resource paths are pinned even when missing; names and remote references remain unchanged", () => {
  fs.mkdirSync("tmp", { recursive: true });
  const startup = fs.mkdtempSync(path.resolve("tmp/resource-paths-"));
  try {
    fs.mkdirSync(path.join(startup, "theme-directory"));
    for (const flag of ["--skill", "--prompt-template", "--theme"]) {
      assert.equal(
        resolveInheritedResource(flag, "./missing-resource.json", startup),
        path.join(startup, "missing-resource.json"),
      );
      assert.equal(
        resolveInheritedResource(flag, "../shared/resource.md", startup),
        path.resolve(startup, "../shared/resource.md"),
      );
      const absolute = path.join(startup, "absolute.json");
      assert.equal(resolveInheritedResource(flag, absolute, startup), absolute);
      assert.equal(resolveInheritedResource(flag, pathToFileURL(absolute).href, startup), absolute);
      assert.equal(
        resolveInheritedResource(flag, "~/resource.json", startup),
        path.join(os.homedir(), "resource.json"),
      );
      for (const ref of [
        "npm:@scope/resources",
        "git:github.com/example/resources",
        "https://example.com/resource",
        "ssh://host/resource",
        "git@host:resource",
        "builtin:resource",
      ]) {
        assert.equal(resolveInheritedResource(flag, ref, startup), ref);
      }
    }
    assert.equal(resolveInheritedResource("--skill", "custom.md", startup), path.join(startup, "custom.md"));
    assert.equal(resolveInheritedResource("--prompt-template", "custom.md", startup), path.join(startup, "custom.md"));
    assert.equal(resolveInheritedResource("--theme", "custom.json", startup), path.join(startup, "custom.json"));
    assert.equal(
      resolveInheritedResource("--theme", "theme-directory", startup),
      path.join(startup, "theme-directory"),
    );
    assert.equal(resolveInheritedResource("--theme", "dark", startup), "dark");
  } finally {
    fs.rmSync(startup, { recursive: true, force: true });
  }
});

test("fake named resume forwards startup resources rather than saved-project shadows in both CLI value forms", () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/resource-resume-"));
  try {
    const startup = path.join(root, "parent-startup");
    const caller = path.join(root, "parent-current");
    const saved = path.join(root, "saved-project");
    const sessionDir = path.join(root, "sessions");
    const agentDir = path.join(root, "agent");
    for (const dir of [startup, caller, saved, sessionDir, agentDir]) fs.mkdirSync(dir);
    for (const dir of [startup, caller, saved]) {
      for (const resource of ["custom.md", "custom.json"]) fs.writeFileSync(path.join(dir, resource), dir);
    }
    // Missing startup resources must stay missing, not become explicit untrusted saved resources.
    fs.writeFileSync(path.join(saved, "missing.md"), "untrusted shadow");
    fs.writeFileSync(path.join(saved, "missing.json"), "untrusted shadow");
    fs.writeFileSync(
      path.join(sessionDir, "session.jsonl"),
      JSON.stringify({ type: "session", id: "saved", cwd: saved }) + "\n",
    );
    const report = path.join(root, "report.json");
    const fake = path.join(root, "fake.mjs");
    fs.writeFileSync(
      fake,
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
    const inherited = [
      "--skill",
      "./custom.md",
      "--skill=./missing.md",
      "--skill",
      "npm:@scope/skills",
      "--prompt-template=./custom.md",
      "--prompt-template",
      "./missing.md",
      "--prompt-template",
      "git:github.com/example/prompts",
      "--theme",
      "./custom.json",
      "--theme=./missing.json",
      "--theme",
      "dark",
      "--theme",
      "https://example.com/theme.json",
      "--use-theme",
      "package/name",
    ];
    const runner = pathToFileURL(path.resolve("runner.ts")).href;
    const types = pathToFileURL(path.resolve("types.ts")).href;
    const code = `
      process.chdir(${JSON.stringify(startup)});
      process.argv = [process.execPath, 'fake-parent', ...${JSON.stringify(inherited)}];
      const { runAgentSubprocess } = await import(${JSON.stringify(runner)});
      const { buildSubagentDetails } = await import(${JSON.stringify(types)});
      // Startup argv is already cached; a later caller cwd must not rebase explicit resources.
      process.chdir(${JSON.stringify(caller)});
      const result = await runAgentSubprocess({ cwd: ${JSON.stringify(caller)}, projectTrusted: true,
        agents: [{ name: 'worker', description: '', source: 'builtin', filePath: '', systemPrompt: '' }],
        agentName: 'worker', task: 'continue', parentDepth: 0, parentAgentStack: [], maxDepth: 1, preventCycles: false,
        sessionDir: ${JSON.stringify(sessionDir)}, resumeSession: true, resumeSettings: { model: 'saved/model' },
        makeDetails: results => buildSubagentDetails('single', 'spawn', null, results),
        piCommandOverride: { command: process.execPath, argsPrefix: [${JSON.stringify(fake)}] } });
      console.log(JSON.stringify({ exitCode: result.exitCode, error: result.errorMessage }));
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: root };
    delete env["PI-SUBAGENT-EXCLUDE-EXTENSIONS"];
    delete env.PI_SUBAGENT_EXCLUDE_EXTENSIONS;
    const result = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
        timeout: 15000,
      }),
    );
    assert.equal(result.exitCode, 0, result.error);
    const captured = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.equal(captured.cwd, saved);
    assert.deepEqual(values(captured.args, "--skill"), [
      path.join(startup, "custom.md"),
      path.join(startup, "missing.md"),
      "npm:@scope/skills",
    ]);
    assert.deepEqual(values(captured.args, "--prompt-template"), [
      path.join(startup, "custom.md"),
      path.join(startup, "missing.md"),
      "git:github.com/example/prompts",
    ]);
    assert.deepEqual(values(captured.args, "--theme"), [
      path.join(startup, "custom.json"),
      path.join(startup, "missing.json"),
      "dark",
      "https://example.com/theme.json",
    ]);
    assert.deepEqual(values(captured.args, "--use-theme"), ["package/name"]);
    for (const flag of ["--skill", "--prompt-template", "--theme"]) {
      assert.ok(
        !values(captured.args, flag).some(
          (value) => value.startsWith(saved + path.sep) || value.startsWith(caller + path.sep),
        ),
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
