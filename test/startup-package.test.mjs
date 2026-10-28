import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { npm, packedFixture, repo, run } from "./helpers/startup-package.mjs";

let fixture;
before(() => {
  fixture = packedFixture();
});
after(() => fixture?.close());

test("packed manifest selects the bundle and a clean unpacked source build reproduces it", () => {
  const f = fixture;
  assert.equal(f.manifest.main, "startup.js");
  assert.equal(f.manifest.types, "index.ts");
  assert.deepEqual(f.manifest.pi.extensions, ["./startup.js"]);
  assert.ok(f.files.some((file) => file.path === "startup.js"));
  assert.ok(f.files.some((file) => file.path === "scripts/build-startup.mjs"));
  assert.equal(
    f.files.some((file) => file.path.startsWith("node_modules/")),
    false,
  );
  assert.equal(f.manifest.dependencies, undefined, "host packages must not be runtime dependencies");
  const clean = path.join(f.root, "clean");
  cpSync(f.packageRoot, clean, { recursive: true });
  rmSync(path.join(clean, "startup.js"));
  symlinkSync(
    path.join(repo, "node_modules"),
    path.join(clean, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  npm(["run", "build"], { cwd: clean });
  assert.equal(
    readFileSync(path.join(clean, "startup.js"), "utf8"),
    readFileSync(path.join(f.packageRoot, "startup.js"), "utf8"),
  );
});

test("latest Pi gives source and unpacked bundle identical tool declarations, commands and active tools", () => {
  const f = fixture;
  const probe = path.join(f.root, "probe.ts");
  writeFileSync(
    probe,
    `
    export default function(pi) {
      pi.on("session_start", () => {
        const tools = pi.getAllTools().map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
          exposure: tool.exposure, namespace: tool.namespace, promptGuidelines: tool.promptGuidelines })).sort((a, b) => a.name.localeCompare(b.name));
        const commands = pi.getCommands().map(command => ({ name: command.name, description: command.description })).sort((a, b) => a.name.localeCompare(b.name));
        console.log("STARTUP_SNAPSHOT " + JSON.stringify({
          tools: tools.map(tool => tool.name), commands: commands.map(command => command.name), active: pi.getActiveTools().slice().sort(), declarations: { tools, commands },
        }));
      });
    }
  `,
  );
  const cli = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
  const snapshots = [path.join(repo, "index.ts"), path.join(f.packageRoot, f.manifest.pi.extensions[0])].map(
    (entry) => {
      // Separate processes exercise Pi's real host aliases, not native Node SDK copies.
      const output = run(
        process.execPath,
        [
          cli,
          "--offline",
          "--no-session",
          "--no-extensions",
          "--no-mcp",
          "--no-skills",
          "--no-themes",
          "--no-prompt-templates",
          "--no-context-files",
          "--print",
          "-e",
          entry,
          "-e",
          probe,
        ],
        {
          cwd: f.root,
          env: f.env,
          input: "",
          capture: "both",
        },
      );
      const match = output.match(/^STARTUP_SNAPSHOT (.+)$/m);
      assert.ok(match, "Pi must reach session_start and emit its declarations: " + output.slice(0, 2000));
      const snapshot = JSON.parse(match[1]);
      assert.ok(snapshot.tools.includes("subagents"));
      assert.ok(snapshot.tools.includes("message_subagent"));
      return snapshot;
    },
  );
  assert.deepEqual(snapshots[0], snapshots[1]);
});

test("the unpacked package preserves the source entry's public exports", () => {
  const f = fixture;
  const source = pathToFileURL(path.join(repo, "index.ts")).href;
  const built = pathToFileURL(path.join(f.packageRoot, f.manifest.main)).href;
  const consumer = path.join(f.root, "consumer");
  mkdirSync(path.join(consumer, "node_modules"), { recursive: true });
  symlinkSync(
    f.packageRoot,
    path.join(consumer, "node_modules", f.manifest.name),
    process.platform === "win32" ? "junction" : "dir",
  );
  const sourceFile = path.join(consumer, "index.mts");
  writeFileSync(
    sourceFile,
    `
    import extension, { selectParentModelForSubagent, getSubagentsToolDescription, collectCombinedUsageStatusLine, collectLiveUsageSummary } from ${JSON.stringify(f.manifest.name)};
    import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
    const register: (pi: ExtensionAPI) => void = extension;
    void [register, selectParentModelForSubagent, getSubagentsToolDescription, collectCombinedUsageStatusLine, collectLiveUsageSummary];
  `,
  );
  run(process.execPath, [
    path.join(repo, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--strict",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--skipLibCheck",
    "--types",
    "node",
    sourceFile,
  ]);
  const code = `
    import assert from "node:assert/strict";
    const source = await import(${JSON.stringify(source)});
    const built = await import(${JSON.stringify(built)});
    assert.deepEqual(Object.keys(built).sort(), Object.keys(source).sort());
    for (const name of Object.keys(source)) assert.equal(typeof built[name], typeof source[name]);
    console.log("public exports verified");
  `;
  assert.match(
    run(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", code], { env: f.env }),
    /public exports verified/,
  );
});

test("the unpacked bundle launches the caller's runtime entry, never startup.js", () => {
  const f = fixture;
  const project = path.join(f.root, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(f.env.PI_CODING_AGENT_DIR, "pi-subagent.json"),
    JSON.stringify({ limits: { total: 2, concurrency: 1 }, intelligence: { enabled: false } }),
  );
  const log = path.join(f.root, "children.jsonl");
  const host = path.join(repo, "test/fixtures/startup-runtime.mjs");
  const output = run(process.execPath, ["--import", "tsx/esm", host, path.join(f.packageRoot, "startup.js"), project], {
    env: { ...f.env, STARTUP_CHILD_LOG: log },
  });
  assert.match(output, /packed child runtime verified/);
  const children = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(children.length, 1);
  assert.equal(children[0].argv[1], host);
  assert.equal(children[0].cwd, project);
  assert.ok(children[0].argv.includes("--mode"));
  assert.ok(children[0].argv.includes("rpc"));
  assert.equal(children[0].argv.includes(path.join(f.packageRoot, "startup.js")), false);
});
