import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { childExtensionArgs, excludedExtensions, subagentDisabled } from "../runner/extension-policy.js";
import subagentExtension from "../index.js";
import { hostDouble } from "./helpers/extension.js";
import { runAgentSubprocess } from "../runner.js";
import { buildSubagentDetails } from "../types.js";

import { fixture, rpc } from "./helpers/extension-policy.js";

test("environment aliases merge comma lists and disabled factory registers nothing", () => {
  assert.deepEqual(
    excludedExtensions({ "PI-SUBAGENT-EXCLUDE-EXTENSIONS": " one, two,", PI_SUBAGENT_EXCLUDE_EXTENSIONS: "two,three" }),
    ["one", "two", "three"],
  );
  assert.equal(subagentDisabled({ PI_SUBAGENT_DISABLED: "true" }), true);
  assert.equal(subagentDisabled({ "PI-SUBAGENT-DISABLED": "1" }), true);
  assert.equal(subagentDisabled({ PI_SUBAGENT_DISABLED: "0" }), false);
  const previous = process.env.PI_SUBAGENT_DISABLED;
  try {
    process.env.PI_SUBAGENT_DISABLED = "1";
    subagentExtension(hostDouble({}));
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_DISABLED;
    else process.env.PI_SUBAGENT_DISABLED = previous;
  }
});

test("no exclusions return the exact existing args without consulting settings", async () => {
  const args = ["--mode", "rpc", "-e", "npm:missing", "-ne"];
  assert.equal(await childExtensionArgs(args, "/missing", false, [], "/missing"), args);
});

test("RPC excludes automatic and explicit packages, keeps other extensions, and never loads during discovery", async () => {
  const f = fixture();
  try {
    const excluded = f.pkg(
      path.join(f.agentDir, "npm/node_modules/oira666_pi-free-swarm"),
      "oira666_pi-free-swarm",
      "excluded-auto",
    );
    const scoped = f.pkg(
      path.join(f.agentDir, "npm/node_modules/@fixture/explicit"),
      "@fixture/explicit",
      "excluded-explicit",
    );
    const kept = f.pkg(path.join(f.root, "auth"), "fixture-auth", "auth-provider");
    f.write(
      path.join(kept, "index.ts"),
      `
      import { appendFileSync } from "node:fs";
      import { createFauxCore, createProvider } from "@earendil-works/pi-ai";
      appendFileSync(${JSON.stringify(f.marker)}, "auth-provider\\n");
      export default function(pi) {
        const core = createFauxCore({ provider: "fixture-auth", api: "openai-responses", models: [{ id: "fixture-auth-model" }] });
        pi.registerProvider(createProvider({ id: "fixture-auth", name: "Fixture auth", models: core.models,
          auth: { apiKey: { async resolve() { return { auth: { apiKey: "fixture-only" } }; } } },
          api: { stream: core.stream, streamSimple: core.streamSimple } }));
      }
    `,
    );
    f.extension(path.join(f.agentDir, "extensions/kept.ts"), "kept-auto");
    f.extension(path.join(f.cwd, ".pi/extensions/project.ts"), "kept-project");
    const projectExcluded = f.pkg(path.join(f.root, "project-package"), "@fixture/project-swarm", "excluded-project");
    f.write(path.join(f.cwd, ".pi/settings.json"), JSON.stringify({ packages: [projectExcluded] }));
    const settings = f.write(
      path.join(f.agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:oira666_pi-free-swarm@1.2.3", kept] }),
    );
    const original = fs.readFileSync(settings, "utf8");
    const args = await childExtensionArgs(
      ["-e", "npm:@fixture/explicit@1.2.3", "-e", excluded],
      f.cwd,
      true,
      ["oira666_pi-free-swarm", "@fixture/explicit@9.0.0", "@fixture/project-swarm"],
      f.agentDir,
    );
    assert.equal(fs.existsSync(f.marker), false);
    assert.ok(!args.includes(path.join(excluded, "index.ts")));
    assert.ok(!args.includes(path.join(scoped, "index.ts")));
    const loaded = rpc(f, args, true);
    assert.deepEqual(new Set(loaded), new Set(["auth-provider", "kept-auto", "kept-project"]));
    assert.equal(fs.readFileSync(settings, "utf8"), original);
    const nested = await childExtensionArgs(
      args,
      f.cwd,
      true,
      ["oira666_pi-free-swarm", "@fixture/explicit", "@fixture/project-swarm"],
      f.agentDir,
    );
    assert.deepEqual(nested, args);
  } finally {
    f.cleanup();
  }
});

test("untrusted project extensions are not promoted; original -ne keeps only explicit sources", async () => {
  const f = fixture();
  try {
    f.extension(path.join(f.cwd, ".pi/extensions/untrusted.ts"), "untrusted");
    const untrustedPackage = f.pkg(path.join(f.root, "untrusted-package"), "untrusted-package", "untrusted-package");
    f.write(path.join(f.cwd, ".pi/settings.json"), JSON.stringify({ packages: [untrustedPackage] }));
    const auto = f.extension(path.join(f.agentDir, "extensions/auto.ts"), "automatic");
    const explicit = f.extension(path.join(f.root, "explicit.ts"), "explicit");
    const excluded = f.extension(path.join(f.root, "excluded.ts"), "excluded");
    const args = await childExtensionArgs(
      ["--approve", "-e", excluded, "-e", explicit],
      f.cwd,
      false,
      [excluded],
      f.agentDir,
    );
    assert.ok(args.includes(auto));
    assert.ok(args.includes("--no-approve"));
    assert.ok(!args.includes("--approve"));
    assert.deepEqual(new Set(rpc(f, args)), new Set(["automatic", "explicit"]));
    fs.unlinkSync(f.marker);
    const disabled = await childExtensionArgs(["-ne", "-e", explicit], f.cwd, false, ["unused"], f.agentDir);
    assert.deepEqual(rpc(f, disabled), ["explicit"]);
  } finally {
    f.cleanup();
  }
});

test("no exclusions preserve native RPC automatic and explicit loading", async () => {
  const f = fixture();
  try {
    f.extension(path.join(f.agentDir, "extensions/auto.ts"), "automatic");
    const explicit = f.extension(path.join(f.root, "explicit.ts"), "explicit");
    const args = ["--no-approve", "-e", explicit];
    const launch = await childExtensionArgs(args, f.cwd, false, [], f.agentDir);
    assert.equal(launch, args);
    assert.deepEqual(new Set(rpc(f, launch)), new Set(["automatic", "explicit"]));
  } finally {
    f.cleanup();
  }
});

test("path and symlink exclusions match resolved resources; missing explicit sources fail", async () => {
  const f = fixture();
  try {
    const extension = f.extension(path.join(f.agentDir, "extensions/auto.ts"), "automatic");
    const alias = path.join(f.root, "alias.ts");
    fs.symlinkSync(extension, alias);
    const args = await childExtensionArgs([], f.cwd, false, [alias], f.agentDir);
    assert.ok(!args.includes(extension));
    await assert.rejects(
      childExtensionArgs(["-e", "./missing.ts"], f.cwd, false, ["unused"], f.agentDir),
      /Missing explicit extension source/,
    );
    await assert.rejects(
      childExtensionArgs(["-e", "npm:@fixture/not-installed"], f.cwd, false, ["unused"], f.agentDir),
      /must be installed/,
    );
  } finally {
    f.cleanup();
  }
});

test("disabled resources remain disabled and unresolved directories fail closed", async () => {
  const f = fixture();
  try {
    const disabled = f.pkg(path.join(f.root, "disabled"), "disabled-package", "disabled");
    f.write(
      path.join(f.agentDir, "settings.json"),
      JSON.stringify({ packages: [{ source: disabled, extensions: [] }] }),
    );
    const kept = f.extension(path.join(f.agentDir, "extensions/kept.ts"), "kept");
    const args = await childExtensionArgs([], f.cwd, false, ["local"], f.agentDir);
    assert.ok(!args.includes(path.join(disabled, "index.ts")));
    assert.ok(args.includes(kept));
    const entry = f.extension(path.join(f.root, "unresolved/index.ts"), "unresolved");
    await assert.rejects(
      childExtensionArgs(["-e", path.dirname(entry)], f.cwd, false, [entry], f.agentDir),
      /entry point explicitly/,
    );
    assert.equal(fs.existsSync(f.marker), false);
  } finally {
    f.cleanup();
  }
});

test("runner passes filtered args and inherited exclusion aliases to a fake child", async () => {
  const f = fixture();
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousExcludes = process.env["PI-SUBAGENT-EXCLUDE-EXTENSIONS"];
  const previousAlias = process.env.PI_SUBAGENT_EXCLUDE_EXTENSIONS;
  try {
    const excluded = f.extension(path.join(f.agentDir, "extensions/excluded.ts"), "excluded");
    const kept = f.extension(path.join(f.agentDir, "extensions/kept.ts"), "kept");
    const report = path.join(f.root, "launch.json");
    const fake = f.write(
      path.join(f.root, "fake.mjs"),
      `
      import { writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({ args: process.argv.slice(2),
        excludes: process.env["PI-SUBAGENT-EXCLUDE-EXTENSIONS"], alias: process.env.PI_SUBAGENT_EXCLUDE_EXTENSIONS }));
    `,
    );
    process.env.PI_CODING_AGENT_DIR = f.agentDir;
    process.env["PI-SUBAGENT-EXCLUDE-EXTENSIONS"] = excluded;
    process.env.PI_SUBAGENT_EXCLUDE_EXTENSIONS = "other-package";
    await runAgentSubprocess({
      cwd: f.cwd,
      agents: [{ name: "worker", description: "fixture", systemPrompt: "", source: "user", filePath: "worker.md" }],
      agentName: "worker",
      task: "unused",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 1,
      preventCycles: false,
      makeDetails: (results) => buildSubagentDetails("single", "spawn", null, results),
      piCommandOverride: { command: process.execPath, argsPrefix: [fake] },
    });
    const captured: unknown = JSON.parse(fs.readFileSync(report, "utf8"));
    assert.ok(typeof captured === "object" && captured !== null && "args" in captured && Array.isArray(captured.args));
    assert.ok(captured.args.includes("--no-extensions"));
    assert.ok(captured.args.includes(kept));
    assert.ok(!captured.args.includes(excluded));
    assert.ok("excludes" in captured && captured.excludes === excluded);
    assert.ok("alias" in captured && captured.alias === "other-package");
  } finally {
    for (const [key, value] of Object.entries({
      PI_CODING_AGENT_DIR: previousDir,
      "PI-SUBAGENT-EXCLUDE-EXTENSIONS": previousExcludes,
      PI_SUBAGENT_EXCLUDE_EXTENSIONS: previousAlias,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    f.cleanup();
  }
});
