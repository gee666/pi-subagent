import assert from "node:assert/strict";
import * as fs from "node:fs";
import { isRecord } from "../../storage/values.js";

/** Convert a committed ledger into a historical argument format. */
export function rewriteLegacyBudget(file: string, version: 1 | 2 | 3 | 4): void {
  const state: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(isRecord(state));
  assert.ok(isRecord(state.reservations));
  state.version = version;
  for (const reservation of Object.values(state.reservations)) {
    assert.ok(isRecord(reservation));
    assert.ok(Array.isArray(reservation.tasks));
    reservation.tasks = reservation.tasks.map((item: unknown) => {
      assert.ok(isRecord(item));
      assert.equal(typeof item.agent, "string");
      assert.equal(typeof item.task, "string");
      assert.ok(typeof item.max_subagents_allowed === "number");
      return {
        agent: item.agent,
        task: item.task,
        ...(version === 1
          ? { max_subagents_allowed: item.max_subagents_allowed }
          : version === 2
            ? { max_agents_in_branch: item.max_subagents_allowed + 1 }
            : { max_agents_allowed: item.max_subagents_allowed + 1 }),
      };
    });
  }
  fs.writeFileSync(file, JSON.stringify(state));
}
