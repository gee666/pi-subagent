import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RunningSubagentHandle } from "../runner/options.js";
import { openTreeConcurrencyStore, type TreeConcurrencyStore } from "../storage/tree-concurrency.js";
import type { BrokerEndpoint } from "./contracts.js";
import { readManifest, writeExclusive } from "./files.js";

export async function steerBrokerJob(
  endpoint: BrokerEndpoint,
  ownerToken: string,
  targetToken: string,
  message: string,
): Promise<boolean> {
  const manifest = readManifest(endpoint);
  const target = openTreeConcurrencyStore(manifest.concurrencyDirectory).get(targetToken);
  const id = createHash("sha256").update(randomUUID()).digest("hex");
  const request = { id, ordered: true, ownerToken, targetToken, message };
  const mac = createHmac("sha256", endpoint.secret).update(JSON.stringify(request)).digest("hex");
  commitCommand(endpoint, id, { request, mac });
  if (target?.status === "queued") return true; // Durable queued delivery, not model acceptance yet.
  const reply = path.join(endpoint.directory, "command-results", `${id}.json`);
  for (;;) {
    if (fs.existsSync(reply)) {
      try {
        return JSON.parse(fs.readFileSync(reply, "utf8")).accepted === true;
      } catch {
        /* The root may still be completing the write. */
      }
    }
    readManifest(endpoint);
    await delay(25);
  }
}

export async function sendBrokerLead(endpoint: BrokerEndpoint, senderToken: string, message: string): Promise<boolean> {
  readManifest(endpoint);
  const id = createHash("sha256").update(randomUUID()).digest("hex");
  const request = { id, ordered: true, kind: "lead", senderToken, message };
  const mac = createHmac("sha256", endpoint.secret).update(JSON.stringify(request)).digest("hex");
  commitCommand(endpoint, id, { request, mac });
  const reply = path.join(endpoint.directory, "command-results", `${id}.json`);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fs.existsSync(reply)) {
      try {
        return JSON.parse(fs.readFileSync(reply, "utf8")).accepted === true;
      } catch {
        /* Wait for the root's reply to finish writing. */
      }
    }
    readManifest(endpoint);
    await delay(25);
  }
  return false;
}

function syncDirectory(directory: string): void {
  // Windows cannot open directories for fsync. Command files and the log still sync.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function commitCommand(endpoint: BrokerEndpoint, id: string, envelope: unknown): void {
  writeExclusive(path.join(endpoint.directory, "commands", `${id}.json`), envelope);
  writeExclusive(path.join(endpoint.directory, "command-ready", `${id}.json`), { id });
  syncDirectory(path.join(endpoint.directory, "commands"));
  syncDirectory(path.join(endpoint.directory, "command-ready"));
  const fd = fs.openSync(path.join(endpoint.directory, "command-order"), "a", 0o600);
  try {
    // One small O_APPEND write orders same-host submitters. A leading newline
    // separates a torn, unacknowledged tail from the next complete record.
    const record = `\n${id}\n`;
    if (fs.writeSync(fd, record) !== Buffer.byteLength(record)) throw new Error("Incomplete broker order write.");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(endpoint.directory);
}

const pending = new WeakMap<object, Map<string, string>>();
export function processBrokerCommands(
  endpoint: BrokerEndpoint,
  store: TreeConcurrencyStore,
  handles: Map<string, RunningSubagentHandle>,
): void {
  let active = pending.get(handles);
  if (!active) pending.set(handles, (active = new Map()));
  const directory = path.join(endpoint.directory, "command-ready");
  if (!fs.existsSync(directory)) return;
  const ready = fs
    .readdirSync(directory)
    .filter(
      (file) =>
        /^[a-f0-9]{64}\.json$/.test(file) && !fs.existsSync(path.join(endpoint.directory, "command-results", file)),
    );
  const orderFile = path.join(endpoint.directory, "command-order");
  const log = fs.existsSync(orderFile) ? fs.readFileSync(orderFile, "utf8") : "";
  // Only newline-terminated records are committed. Never fall back to mtime
  // for ordered requests whose append has not completed yet.
  const logged = log
    .slice(0, log.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((id) => /^[a-f0-9]{64}$/.test(id))
    .map((id) => `${id}.json`);
  const legacy = ready
    .filter((file) => {
      const { request } = JSON.parse(fs.readFileSync(path.join(endpoint.directory, "commands", file), "utf8"));
      return request.ordered !== true;
    })
    .sort(
      (a, b) =>
        fs.statSync(path.join(directory, a)).mtimeMs - fs.statSync(path.join(directory, b)).mtimeMs ||
        a.localeCompare(b),
    );
  const blocked = new Set<string>();
  for (const file of new Set([...legacy, ...logged])) {
    if (!fs.existsSync(path.join(directory, file))) continue;
    const reply = path.join(endpoint.directory, "command-results", file);
    if (fs.existsSync(reply)) continue;
    const { request, mac } = JSON.parse(fs.readFileSync(path.join(endpoint.directory, "commands", file), "utf8"));
    const expected = createHmac("sha256", endpoint.secret).update(JSON.stringify(request)).digest("hex");
    if (mac !== expected) throw new Error("Invalid broker command credentials.");
    const lead = request.kind === "lead";
    const sender = lead ? store.get(request.senderToken) : undefined;
    const target = store.get(lead ? (sender?.parentToken ?? "") : request.targetToken);
    if (
      !target ||
      (lead
        ? sender?.status !== "running" || target.status !== "running"
        : target.parentToken !== request.ownerToken) ||
      ["stopping", "canceled", "released", "rejected", "parking", "suspended", "waking"].includes(target.status)
    ) {
      writeExclusive(reply, { accepted: false });
      if (target && active.get(target.token) === file) active.delete(target.token);
      continue;
    }
    if (blocked.has(target.token) || active.has(target.token)) continue;
    blocked.add(target.token);
    const handle = handles.get(target.token);
    if (!handle) {
      if (lead) writeExclusive(reply, { accepted: false });
      continue; // Durable queued child steering waits for a root-owned handle.
    }
    if (lead) store.markWaiting(target.token, false);
    active.set(target.token, file);
    const finish = (accepted: boolean): void => {
      // A stop can reject this command while its RPC is still unresolved.
      if (!fs.existsSync(reply)) writeExclusive(reply, { accepted });
    };
    void Promise.resolve()
      .then(() => {
        if (fs.existsSync(reply)) return false;
        // Stop may race the poll before this microtask reaches the handle.
        const current = store.get(target.token);
        if (
          !current ||
          ["stopping", "canceled", "released", "rejected", "parking", "suspended", "waking"].includes(current.status) ||
          (lead && (current.status !== "running" || store.get(request.senderToken)?.status !== "running"))
        )
          return false;
        return handle.steer(lead ? `Message from subagent ${sender!.name}:\n${request.message}` : request.message);
      })
      .then(
        (accepted) => finish(accepted !== false),
        () => finish(false),
      )
      .finally(() => {
        if (active!.get(target.token) === file) active!.delete(target.token);
      });
  }
}
