import * as fs from "node:fs";
import * as path from "node:path";
import { fork } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { BudgetTask } from "../../budget.js";
import { isRecord } from "../../storage/values.js";

export function workspace(): string {
  const root = path.join(process.cwd(), "tmp");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "budget-test-"));
}

export function task(max_agents_allowed = 1): BudgetTask {
  return { agent: "worker", task: "work", max_agents_allowed };
}

export async function race(
  directory: string,
  ids: string[],
  actions?: Array<Record<string, unknown>>,
): Promise<Array<{ ok: boolean; error?: string }>> {
  const file = path.join(directory, "race-worker.mjs");
  const moduleUrl = pathToFileURL(path.join(process.cwd(), "budget.ts")).href;
  fs.writeFileSync(
    file,
    `
    import { reserveSubagentBudgets, overrideResumeBudgets } from ${JSON.stringify(moduleUrl)};
    process.once('message', ({ budget, id, override, reserveBudget }) => {
      try {
        if (override) overrideResumeBudgets(budget, [override]);
        else reserveSubagentBudgets(reserveBudget || budget, id, [{ agent: 'worker', task: 'work', max_agents_allowed: 2 }]);
        process.send({ ok: true });
      } catch (error) { process.send({ ok: false, error: error.message }); }
      process.disconnect();
    });
    process.send({ ready: true });
  `,
  );
  const children = ids.map(() =>
    fork(file, {
      execArgv: ["--import", "tsx/esm"],
      env: { ...process.env, TMPDIR: directory },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }),
  );
  const results = children.map(
    (child, index) =>
      new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
        let answer: { ok: boolean; error?: string } | undefined;
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("message", (message: unknown) => {
          if (isRecord(message) && message.ready === true) {
            ready++;
            if (ready === children.length)
              children.forEach((worker, i) =>
                worker.send({ budget: { directory: path.join(directory, "budget") }, id: ids[i], ...actions?.[i] }),
              );
          } else if (
            isRecord(message) &&
            typeof message.ok === "boolean" &&
            (message.error === undefined || typeof message.error === "string")
          ) {
            answer = { ok: message.ok, ...(message.error !== undefined ? { error: message.error } : {}) };
          } else reject(new Error("Invalid budget worker response"));
        });
        child.on("exit", (code) =>
          answer && code === 0 ? resolve(answer) : reject(new Error(`Worker ${index} failed: ${stderr}`)),
        );
      }),
  );
  let ready = 0;
  const timer = setTimeout(() => children.forEach((child) => child.kill("SIGKILL")), 20_000);
  try {
    return await Promise.all(results);
  } finally {
    clearTimeout(timer);
    children.forEach((child) => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
  }
}
