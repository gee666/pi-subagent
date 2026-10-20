import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { readWorkerStops, persistWorkerStops } from "../storage/worker-stops.js";
import { readNamesRegistry } from "../names.js";
import { settingsFixture } from "./helpers/settings.js";
import * as path from "node:path";

test("stop sidecars merge concurrent events monotonically and ignore incomplete candidates", () => {
  const f = settingsFixture();
  try {
    const file = path.join(f.root, "names.json");
    persistWorkerStops(file, ["Ada", "Bo"], 20);
    persistWorkerStops(file, ["Ada"], 10);
    persistWorkerStops(file, ["Bo"], 30);
    fs.writeFileSync(path.join(`${file}.stops`, "unfinished.tmp"), "incomplete");
    assert.deepEqual(
      readWorkerStops(file),
      new Map([
        ["Ada", 20],
        ["Bo", 30],
      ]),
    );
  } finally {
    f.close();
  }
});

test("corrupt stop markers fail closed without treating a valid names registry as corrupt", () => {
  const f = settingsFixture();
  try {
    const file = path.join(f.root, "names.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, counters: {}, agents: {} }));
    persistWorkerStops(file, ["Ada"]);
    fs.writeFileSync(path.join(`${file}.stops`, "bad.json"), "malformed");
    assert.throws(() => readNamesRegistry(file), /automatic recovery is blocked/);
    assert.equal(
      fs.readdirSync(f.root).some((name) => name.includes(".corrupt-")),
      false,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).agents, {});
  } finally {
    f.close();
  }
});
