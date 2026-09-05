import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, afterEach } from "node:test";

export function namesFixture() {
  const fixture = { tmpDir: "", namesFile: "" };
  beforeEach(() => {
    const root = path.resolve("tmp");
    fs.mkdirSync(root, { recursive: true });
    fixture.tmpDir = fs.mkdtempSync(path.join(root, "pi-subagent-names-test-"));
    fixture.namesFile = path.join(fixture.tmpDir, "subagent-names.json");
  });
  afterEach(() => {
    fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  });
  return fixture;
}
