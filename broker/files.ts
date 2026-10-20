import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { matchesProcess, openTreeConcurrencyStore } from "../storage/tree-concurrency.js";
import { compactSingleResultForDurableDetails, isResultError, type SingleResult } from "../types.js";
import type {
  BrokerEndpoint,
  BrokerJobSpec,
  BrokerManifest,
  BrokerReceipt,
  BrokerResult,
  BrokerSubmission,
} from "./contracts.js";

export function brokerPath(endpoint: BrokerEndpoint, kind: string, id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid broker job identity.");
  return path.join(endpoint.directory, kind, `${id}.json`);
}
export function writeExclusive(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function readManifest(endpoint: BrokerEndpoint): BrokerManifest {
  const secret = fs.readFileSync(path.join(endpoint.directory, "secret"), "utf8");
  const a = Buffer.from(secret),
    b = Buffer.from(endpoint.secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid broker credentials.");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(endpoint.directory, "manifest.json"), "utf8"),
  ) as BrokerManifest;
  if (manifest.version !== 1 || !matchesProcess(manifest.rootPid, manifest.rootStartTime))
    throw new Error("The root worker broker is unavailable. Saved work was not relaunched.");
  return manifest;
}
function signature(endpoint: BrokerEndpoint, spec: BrokerJobSpec): string {
  return createHmac("sha256", endpoint.secret).update(JSON.stringify(spec)).digest("hex");
}
export function readBrokerJob(endpoint: BrokerEndpoint, id: string): BrokerJobSpec {
  const envelope = JSON.parse(fs.readFileSync(brokerPath(endpoint, "jobs", id), "utf8"));
  const spec = envelope.spec as BrokerJobSpec;
  if (
    spec?.version !== 1 ||
    spec.id !== id ||
    typeof envelope.mac !== "string" ||
    signature(endpoint, spec) !== envelope.mac
  )
    throw new Error("Invalid authenticated broker job.");
  return spec;
}
export function listBrokerJobs(endpoint: BrokerEndpoint, pendingOnly = false): BrokerJobSpec[] {
  readManifest(endpoint);
  const ready = path.join(endpoint.directory, "ready");
  if (!fs.existsSync(ready)) return [];
  return fs
    .readdirSync(ready)
    .filter(
      (file) =>
        /^[a-f0-9]{64}\.json$/.test(file) &&
        (!pendingOnly || !fs.existsSync(brokerPath(endpoint, "finished", file.slice(0, -5)))),
    )
    .map((file) => readBrokerJob(endpoint, file.slice(0, -5)));
}

/** Receipt is synchronous and durable. No local admission queue can hide a nested launch. */
export function submitBrokerJob(
  endpoint: BrokerEndpoint,
  input: BrokerSubmission,
  preparedToken?: string,
): BrokerReceipt {
  const manifest = readManifest(endpoint);
  const id = createHash("sha256")
    .update(JSON.stringify([input.ownerToken, input.toolCallId, input.taskIndex]))
    .digest("hex");
  const ready = brokerPath(endpoint, "ready", id);
  if (fs.existsSync(ready)) {
    const previous = readBrokerJob(endpoint, id);
    if (previous.name !== input.name || previous.task.task !== input.task.task)
      throw new Error("Broker submission identity conflicts with existing work.");
    return { id, token: previous.token, name: previous.name, status: "queued" };
  }
  const store = openTreeConcurrencyStore(manifest.concurrencyDirectory);
  const parent = store.get(input.ownerToken);
  if (!parent || parent.pid !== process.pid || !store.isProcessAlive(parent))
    throw new Error("Only the running owner worker may submit nested work.");
  const token = preparedToken ?? store.enqueue(input.name, input.ownerToken);
  const spec: BrokerJobSpec = JSON.parse(JSON.stringify({ ...input, submittedAt: Date.now(), version: 1, id, token }));
  const reservation = store.get(token);
  if (!reservation || reservation.parentToken !== input.ownerToken || reservation.name !== input.name)
    throw new Error("Broker reservation does not belong to the submitting worker.");
  try {
    writeExclusive(brokerPath(endpoint, "jobs", id), { spec, mac: signature(endpoint, spec) });
    writeExclusive(ready, { id });
  } catch (error) {
    store.stopSubtree(token);
    store.release(token);
    throw error;
  }
  return { id, token, name: input.name, status: "queued" };
}

export function readBrokerResult(endpoint: BrokerEndpoint, id: string): SingleResult | undefined {
  const file = brokerPath(endpoint, "results", id);
  if (!fs.existsSync(brokerPath(endpoint, "finished", id))) return undefined;
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as BrokerResult;
  if (stored.version !== 1 || stored.id !== id) throw new Error("Invalid broker result.");
  return stored.result;
}
export function persistBrokerResult(endpoint: BrokerEndpoint, id: string, result: SingleResult): void {
  if (fs.existsSync(brokerPath(endpoint, "finished", id))) return;
  const compact = compactSingleResultForDurableDetails(result);
  if (!compact.errorMessage && result.stderr && isResultError(result)) compact.errorMessage = result.stderr;
  writeExclusive(brokerPath(endpoint, "results", id), { version: 1, id, result: compact });
  writeExclusive(brokerPath(endpoint, "finished", id), { id });
}
export async function watchBrokerJob(
  endpoint: BrokerEndpoint,
  id: string,
  signal?: AbortSignal,
  onLead?: (text: string) => void,
): Promise<SingleResult> {
  const seen = new Set<string>();
  for (;;) {
    signal?.throwIfAborted();
    const leads = path.join(endpoint.directory, "leads", id);
    if (onLead && fs.existsSync(leads)) {
      const spec = readBrokerJob(endpoint, id);
      const store = openTreeConcurrencyStore(readManifest(endpoint).concurrencyDirectory);
      const parent = store.get(spec.ownerToken);
      for (const file of fs.readdirSync(leads)) {
        if (seen.has(file)) continue;
        seen.add(file);
        const event = JSON.parse(fs.readFileSync(path.join(leads, file), "utf8"));
        if (parent?.status === "running" && parent.pid === process.pid && event.ownerPid === process.pid)
          onLead(String(event.message));
      }
    }
    const result = readBrokerResult(endpoint, id);
    if (result) return result;
    readManifest(endpoint);
    await delay(25, undefined, { signal });
  }
}
export function ackBrokerJob(endpoint: BrokerEndpoint, id: string): void {
  const file = brokerPath(endpoint, "acks", id);
  if (!fs.existsSync(file)) writeExclusive(file, { id, at: Date.now() });
}
export function pendingBrokerJobs(endpoint: BrokerEndpoint, ownerToken: string): BrokerJobSpec[] {
  return listBrokerJobs(endpoint).filter(
    (spec) => spec.ownerToken === ownerToken && !fs.existsSync(brokerPath(endpoint, "acks", spec.id)),
  );
}
