import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord } from "./values.js";
import {
  isBudgetAmount,
  isBranchBudgetAmount,
  SubagentBudgetError,
  type SubagentBudget,
  type BudgetState,
  type Reservation,
} from "./budget-state.js";

function decodeReservation(value: unknown, version: number): Reservation {
  if (
    !isRecord(value) ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.children) ||
    value.tasks.length !== value.children.length
  ) {
    throw new Error("invalid reservation");
  }
  const sizes = value.reservedSizes;
  if (sizes !== undefined && (!Array.isArray(sizes) || sizes.length !== value.tasks.length)) {
    throw new Error("invalid reserved sizes");
  }
  const reservation: Reservation = { ...value, tasks: [], children: [] };
  const reservedSizes: number[] = [];
  for (const [index, task] of value.tasks.entries()) {
    if (!isRecord(task) || typeof task.agent !== "string" || typeof task.task !== "string") {
      throw new Error("invalid reservation task");
    }
    // Versions 2–4 stored inclusive task sizes. Keep old ledgers readable
    // without changing their balances or inclusive reservation high-water marks.
    let allowance = task.max_subagents_allowed;
    if (version >= 2 && version <= 4) {
      const inclusive = version === 2 ? task.max_agents_in_branch : task.max_agents_allowed;
      if (!isBudgetAmount(inclusive) || inclusive < 1) throw new Error("invalid legacy child allowance");
      allowance = inclusive - 1;
    }
    const child: unknown = value.children[index];
    if (
      !isBranchBudgetAmount(allowance) ||
      !isRecord(child) ||
      typeof child.directory !== "string" ||
      !path.isAbsolute(child.directory)
    ) {
      throw new Error("invalid child allowance");
    }
    const size = allowance + 1;
    const reserved: unknown = Array.isArray(sizes) ? (sizes[index] ?? size) : size;
    if (!isBudgetAmount(reserved) || reserved < size) throw new Error("invalid reserved size");
    // Replay uses the migrated argument, not obsolete inclusive fields.
    reservation.tasks.push({ agent: task.agent, task: task.task, max_subagents_allowed: allowance });
    reservation.children.push({ ...child, directory: child.directory });
    reservedSizes.push(reserved);
  }
  if (sizes !== undefined) reservation.reservedSizes = reservedSizes;
  return reservation;
}

function decodeState(value: unknown): BudgetState {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4 && value.version !== 5) ||
    !isBudgetAmount(value.limit) ||
    !isBudgetAmount(value.remaining) ||
    value.remaining > value.limit ||
    !isRecord(value.reservations)
  ) {
    throw new Error("invalid budget state");
  }
  const version = value.version;
  const reservations = Object.fromEntries(
    Object.entries(value.reservations).map(([key, reservation]) => [key, decodeReservation(reservation, version)]),
  );
  let allocated = 0;
  for (const reservation of Object.values(reservations)) {
    allocated += reservation.tasks.reduce(
      (sum, task, index) => sum + (reservation.reservedSizes?.[index] ?? task.max_subagents_allowed + 1),
      0,
    );
  }
  if (!Number.isSafeInteger(allocated) || value.limit - allocated !== value.remaining) {
    throw new Error("budget totals do not match reservations");
  }
  return { ...value, version: 5, limit: value.limit, remaining: value.remaining, reservations };
}

export function latestState(budget: SubagentBudget): { revision: number; state: BudgetState } {
  try {
    let revision = -1;
    for (const name of fs.readdirSync(budget.directory)) {
      const match = /^state-(\d+)\.json$/.exec(name);
      if (match) revision = Math.max(revision, Number(match[1]));
    }
    if (!isBudgetAmount(revision)) throw new Error("no committed budget state");
    const state = decodeState(
      JSON.parse(fs.readFileSync(path.join(budget.directory, `state-${revision}.json`), "utf8")),
    );
    return { revision, state };
  } catch (error) {
    throw new SubagentBudgetError(
      `Cannot read subagent budget at ${budget.directory}: ${error instanceof Error ? error.message : error}. New launches are blocked; the allowance will not be reset.`,
    );
  }
}

/**
 * Publish immutable revisions by atomic hard link. Only one competing writer
 * wins; others retry. Old revisions must remain to prevent an ABA race.
 */
export function commit(budget: SubagentBudget, revision: number, state: BudgetState): boolean {
  const temporaryDirectory = path.join(budget.directory, "tmp");
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  const candidate = path.join(temporaryDirectory, `${process.pid}-${randomUUID()}.json`);
  const fd = fs.openSync(candidate, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(candidate, path.join(budget.directory, `state-${revision}.json`));
      return true;
    } catch (error) {
      if (isRecord(error) && error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    fs.rmSync(candidate, { force: true });
  }
}
