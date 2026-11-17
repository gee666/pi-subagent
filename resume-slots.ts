import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sessionEntryMessage } from "./storage/session-entries.js";
import {
  asyncJobId,
  isSubagentDetails,
  SUBAGENT_COMPLETION_TYPE,
  type SingleResult,
  type SubagentDetails,
} from "./types.js";
import type { ResumableSubagentCall, ResumableTask } from "./resume.js";

/** An async launch receipt recorded on the active branch, in entry order. */
export interface AsyncLaunch {
  toolCallId: string;
  tasks: ResumableTask[];
  details: SubagentDetails;
  order: number;
}

/** One worker of an original launch, tracked through recoveries and later runs. */
interface Slot {
  launch: AsyncLaunch;
  index: number;
  result: SingleResult;
  /** Entry order of the latest launch receipt that (re)started this worker. */
  order: number;
  jobId: string;
  jobIndex: number;
}

function workerKeys(result: SingleResult): string[] {
  const keys: string[] = [];
  if (result.sessionDir) keys.push(`dir:${result.sessionDir}`);
  if (result.name) keys.push(`name:${result.name}`);
  return keys;
}

const jobKey = (jobId: unknown, index: unknown) => JSON.stringify([jobId, index]);

/**
 * Async workers that were still running when the session ended.
 *
 * A worker is pending only while its latest record is the launch placeholder
 * (exit code -1). Any completion of that run closes it, including failures and
 * stops, because only interrupted work is recovered. A completion belongs to
 * the run when it carries the run's job and task index. A completion from a
 * job that never launched this worker, such as a message resume, closes it
 * when it follows the latest receipt. A completion from an older launch of the
 * worker belongs to a superseded run and is ignored.
 *
 * A recovery reuses the worker's session directory and name, so it folds into
 * the original launch. Plans keep that launch's tool-call id, which also keys
 * budget reservations and default session directories.
 */
export function findPendingAsyncPlans(entries: SessionEntry[], launches: AsyncLaunch[]): ResumableSubagentCall[] {
  const slots: Slot[] = [];
  const byKey = new Map<string, Slot>();
  const byJob = new Map<string, Slot>();
  for (const launch of launches) {
    launch.details.results.forEach((result, index) => {
      const keys = workerKeys(result);
      let slot = keys.map((key) => byKey.get(key)).find((candidate) => candidate !== undefined);
      if (slot) {
        Object.assign(slot, { result, order: launch.order, jobId: launch.toolCallId, jobIndex: index });
      } else if (launch.tasks[index]) {
        slot = { launch, index, result, order: launch.order, jobId: launch.toolCallId, jobIndex: index };
        slots.push(slot);
      } else return;
      for (const key of keys) byKey.set(key, slot);
      byJob.set(jobKey(launch.toolCallId, index), slot);
    });
  }

  entries.forEach((entry, order) => {
    const message = sessionEntryMessage(entry);
    if (message?.role !== "custom" || message.customType !== SUBAGENT_COMPLETION_TYPE) return;
    if (!isSubagentDetails(message.details)) return;
    const jobId = asyncJobId(message.details);
    const taskIndex = Reflect.get(message.details, "asyncTaskIndex");
    const launched = byJob.get(jobKey(jobId, taskIndex));
    for (const result of message.details.results) {
      if (launched) {
        if (launched.jobId === jobId && launched.jobIndex === taskIndex) launched.result = result;
        continue;
      }
      const slot = workerKeys(result)
        .map((key) => byKey.get(key))
        .find((candidate) => candidate !== undefined);
      if (slot && order > slot.order) slot.result = result;
    }
  });

  const plans = new Map<AsyncLaunch, { tasks: ResumableTask[]; taskIndexes: number[]; results: SingleResult[] }>();
  for (const slot of slots) {
    if (slot.result.exitCode !== -1) continue;
    const plan = plans.get(slot.launch) ?? { tasks: [], taskIndexes: [], results: [] };
    plans.set(slot.launch, plan);
    plan.tasks.push(slot.launch.tasks[slot.index]);
    plan.taskIndexes.push(slot.index);
    plan.results.push(slot.result);
  }
  return [...plans].map(([launch, { tasks, taskIndexes, results }]) => ({
    previousToolCallId: launch.toolCallId,
    tasks,
    taskIndexes,
    details: { ...launch.details, results },
  }));
}
