import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadPiSubagentsConfig } from "../config.js";

const validSmartDecision = {
  enabled: true,
  model: "jev",
  api_key: "test-only-secret",
  use_models: [{ "provider/model/high": "Use for hard tasks" }],
};

function setup() {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/config-fallback-"));
  const agentDir = path.join(root, "agent");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  return {
    root,
    agentDir,
    agentFile: path.join(agentDir, "pi-subagents.json"),
    projectDir,
    projectFile: path.join(projectDir, ".pi", "pi-subagents.json"),
  };
}

function withAgentDir(run: (dirs: ReturnType<typeof setup>) => void): void {
  const dirs = setup();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
  try {
    run(dirs);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.chmodSync(dirs.agentDir, 0o700);
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
}

test("persists a missing fallback while preserving unrelated configuration and file permissions", () => {
  withAgentDir((dirs) => {
    fs.writeFileSync(
      dirs.agentFile,
      JSON.stringify({ unrelated: { keep: [1, "two"] }, "smart-decision": validSmartDecision }),
    );
    fs.chmodSync(dirs.agentFile, 0o666);
    const previousUmask = process.umask(0o077);
    let loaded: ReturnType<typeof loadPiSubagentsConfig>;
    try {
      loaded = loadPiSubagentsConfig();
    } finally {
      process.umask(previousUmask);
    }
    const saved = JSON.parse(fs.readFileSync(dirs.agentFile, "utf8"));

    assert.equal(loaded.smartDecision?.fallback, true);
    assert.equal(saved["smart-decision"].fallback, true);
    assert.deepEqual(saved.unrelated, { keep: [1, "two"] });
    assert.equal(fs.statSync(dirs.agentFile).mode & 0o777, 0o666);
  });
});

for (const fallback of [false, true] as const) {
  test(`leaves an existing fallback=${fallback} file byte-for-byte unchanged`, () => {
    withAgentDir((dirs) => {
      const source = ` {\n  "unrelated": "keep",\n  "smart-decision": ${JSON.stringify({ ...validSmartDecision, fallback })}\n}\n\n`;
      fs.writeFileSync(dirs.agentFile, source);

      assert.equal(loadPiSubagentsConfig().smartDecision?.fallback, fallback);
      assert.equal(fs.readFileSync(dirs.agentFile, "utf8"), source);
    });
  });
}

test("persists the fallback on an existing disabled section without enabling it", () => {
  withAgentDir((dirs) => {
    fs.writeFileSync(dirs.agentFile, JSON.stringify({ "smart-decision": { enabled: false }, keep: 7 }));

    assert.equal(loadPiSubagentsConfig().smartDecision, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(dirs.agentFile, "utf8")), {
      "smart-decision": { enabled: false, fallback: true },
      keep: 7,
    });
  });
});

test("does not create a missing config or a missing smart-decision section", () => {
  withAgentDir((dirs) => {
    assert.equal(loadPiSubagentsConfig().smartDecision, undefined);
    assert.equal(fs.existsSync(dirs.agentFile), false);

    const source = '{\n  "unrelated": true\n}\n';
    fs.writeFileSync(dirs.agentFile, source);
    loadPiSubagentsConfig();
    assert.equal(fs.readFileSync(dirs.agentFile, "utf8"), source);
  });
});

test("leaves an untrusted project untouched and persists it once trusted", () => {
  withAgentDir((dirs) => {
    const source = JSON.stringify({ "smart-decision": validSmartDecision });
    fs.writeFileSync(dirs.projectFile, source);

    assert.equal(loadPiSubagentsConfig(dirs.projectDir, false).smartDecision, undefined);
    assert.equal(fs.readFileSync(dirs.projectFile, "utf8"), source);

    assert.equal(loadPiSubagentsConfig(dirs.projectDir, true).smartDecision?.fallback, true);
    assert.equal(JSON.parse(fs.readFileSync(dirs.projectFile, "utf8"))["smart-decision"].fallback, true);
  });
});

test(
  "preserves a symlinked config while atomically replacing its target",
  { skip: process.platform === "win32" },
  () => {
    withAgentDir((dirs) => {
      const target = path.join(dirs.agentDir, "actual-config.json");
      fs.writeFileSync(target, JSON.stringify({ keep: "target", "smart-decision": validSmartDecision }));
      fs.symlinkSync(path.basename(target), dirs.agentFile);

      assert.equal(loadPiSubagentsConfig().smartDecision?.fallback, true);
      assert.equal(fs.lstatSync(dirs.agentFile).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(dirs.agentFile), path.basename(target));
      const saved = JSON.parse(fs.readFileSync(target, "utf8"));
      assert.equal(saved.keep, "target");
      assert.equal(saved["smart-decision"].fallback, true);
    });
  },
);

test("does not remove a colliding temp file that it did not create", () => {
  withAgentDir((dirs) => {
    fs.writeFileSync(dirs.agentFile, JSON.stringify({ "smart-decision": validSmartDecision }));
    const blockers = Array.from({ length: 32 }, (_, index) =>
      path.join(dirs.agentDir, `.pi-subagents.json.${process.pid}.${index}.tmp`),
    );
    for (const blocker of blockers) fs.writeFileSync(blocker, `collision-${path.basename(blocker)}`);

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      assert.equal(loadPiSubagentsConfig().smartDecision?.fallback, true);
    } finally {
      console.warn = originalWarn;
    }

    for (const blocker of blockers) {
      assert.equal(fs.readFileSync(blocker, "utf8"), `collision-${path.basename(blocker)}`);
    }
    assert.equal(
      Object.hasOwn(JSON.parse(fs.readFileSync(dirs.agentFile, "utf8"))["smart-decision"], "fallback"),
      false,
    );
    assert.equal(warnings.length, 1);
  });
});

test("uses runtime fallback=true and emits a credential-free warning when persistence fails", () => {
  withAgentDir((dirs) => {
    const rawMarker = "raw-json-marker";
    fs.writeFileSync(dirs.agentFile, JSON.stringify({ marker: rawMarker, "smart-decision": validSmartDecision }));
    fs.chmodSync(dirs.agentDir, 0o500);
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      assert.equal(loadPiSubagentsConfig().smartDecision?.fallback, true);
    } finally {
      console.warn = originalWarn;
      fs.chmodSync(dirs.agentDir, 0o700);
    }

    assert.equal(
      Object.hasOwn(JSON.parse(fs.readFileSync(dirs.agentFile, "utf8"))["smart-decision"], "fallback"),
      false,
    );
    assert.equal(warnings.length, 1);
    const warning = warnings.flat().join(" ");
    assert.match(warning, /Failed to save the default smart-decision fallback/);
    assert.equal(warning.includes(validSmartDecision.api_key), false);
    assert.equal(warning.includes(rawMarker), false);
    assert.equal(warning.includes(dirs.agentFile), false);
  });
});
