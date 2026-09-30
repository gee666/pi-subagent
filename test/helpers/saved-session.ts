import * as fs from "node:fs";
import * as path from "node:path";
import type { TestContext } from "node:test";

/** A dedicated valid transcript, never an unrelated jsonl from the shared system temp directory. */
export function savedSessionDir(t: TestContext): string {
  fs.mkdirSync("tmp", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("tmp/saved-session-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, "session.jsonl"),
    JSON.stringify({ type: "session", version: 3, id: "fixture", cwd: dir }) + "\n",
  );
  return dir;
}
