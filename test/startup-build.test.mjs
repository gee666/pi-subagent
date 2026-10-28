import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildStartup } from "../scripts/build-startup.mjs";

const tmp = fileURLToPath(new URL("../tmp/", import.meta.url));
function fixture() {
  mkdirSync(tmp, { recursive: true });
  const root = mkdtempSync(path.join(tmp, "startup-build-"));
  function write(file, text) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  write("package.json", '{"type":"module"}');
  return { root, write, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("startup build keeps Pi and TypeBox external", async () => {
  const f = fixture();
  try {
    f.write("index.ts", 'export { Text } from "@earendil-works/pi-tui"; export { Type } from "@sinclair/typebox";');
    const metadata = await buildStartup({ root: f.root });
    assert.deepEqual(Object.keys(metadata.inputs), ["index.ts"]);
    assert.deepEqual(
      metadata.outputs["startup.js"].imports.map(({ path, external }) => ({ path, external })),
      [
        { path: "@earendil-works/pi-tui", external: true },
        { path: "@sinclair/typebox", external: true },
      ],
    );
  } finally {
    f.close();
  }
});

test("startup build preserves source-relative assets and executable child URLs after relocation", async () => {
  const f = fixture();
  const relocated = f.root + "-relocated";
  try {
    f.write("index.ts", 'export { asset, worker, origin } from "./nested/module #.ts";');
    f.write(
      "nested/module #.ts",
      `
      import { readFileSync } from "node:fs";
      export const origin = import.meta.url;
      export const asset = () => readFileSync(new URL("../assets/data%20%23.txt", import.meta.url), "utf8");
      export const worker = new URL("./worker.mjs", import.meta.url);
    `,
    );
    f.write("assets/data #.txt", "asset survived relocation");
    f.write(
      "nested/worker.mjs",
      'import { fileURLToPath } from "node:url"; console.log(fileURLToPath(import.meta.url));',
    );
    await buildStartup({ root: f.root });
    renameSync(f.root, relocated);
    const built = await import(pathToFileURL(path.join(relocated, "startup.js")).href);
    assert.equal(built.origin, pathToFileURL(path.join(relocated, "nested/module #.ts")).href);
    assert.equal(built.asset(), "asset survived relocation");
    assert.equal(
      execFileSync(process.execPath, [fileURLToPath(built.worker)], { encoding: "utf8", timeout: 10000 }).trim(),
      path.join(relocated, "nested/worker.mjs"),
    );
  } finally {
    f.close();
    rmSync(relocated, { recursive: true, force: true });
  }
});

test("startup build rejects outside source before writing an artifact", async () => {
  const f = fixture();
  const outside = path.join(tmp, path.basename(f.root) + ".ts");
  try {
    writeFileSync(outside, "export const outside = true;");
    f.write("index.ts", `export * from ${JSON.stringify("../" + path.basename(outside))};`);
    await assert.rejects(buildStartup({ root: f.root }), /only this package's source/);
    assert.throws(() => readFileSync(path.join(f.root, "startup.js")), { code: "ENOENT" });
  } finally {
    f.close();
    rmSync(outside, { force: true });
  }
});
