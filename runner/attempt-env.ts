import { SUBAGENT_SESSION_ROOT_ENV } from "../resume.js";
import { SUBAGENT_NAMES_FILE_ENV } from "../names.js";
import { SUBAGENT_BUDGET_DIR_ENV } from "../budget.js";
import { SUBAGENT_RUN_INTELLIGENCE_ENV } from "../intelligence.js";
import { TREE_CONCURRENCY_DIR_ENV, WORKER_TOKEN_ENV } from "../storage/tree-concurrency.js";
import { BROKER_DIR_ENV, BROKER_SECRET_ENV } from "../broker/contracts.js";
import {
  SUBAGENT_DEPTH_ENV,
  SUBAGENT_MAX_DEPTH_ENV,
  SUBAGENT_STACK_ENV,
  SUBAGENT_PREVENT_CYCLES_ENV,
  SUBAGENT_FALLBACK_MODEL_ENV,
} from "./constants.js";
import { buildChildProcessEnv } from "./launch.js";
import type { RunAgentOptions } from "./options.js";
import type { SingleResult } from "../types.js";

export function attemptEnvironment(opts: RunAgentOptions, result: SingleResult): NodeJS.ProcessEnv {
  return buildChildProcessEnv({
    [SUBAGENT_DEPTH_ENV]: String(Math.max(0, Math.floor(opts.parentDepth)) + 1),
    [SUBAGENT_MAX_DEPTH_ENV]: String(Math.max(0, Math.floor(opts.maxDepth))),
    [SUBAGENT_STACK_ENV]: JSON.stringify([...opts.parentAgentStack, opts.agentName]),
    [SUBAGENT_PREVENT_CYCLES_ENV]: opts.preventCycles ? "1" : "0",
    ...(opts.sessionRoot ? { [SUBAGENT_SESSION_ROOT_ENV]: opts.sessionRoot } : {}),
    ...(opts.namesFile ? { [SUBAGENT_NAMES_FILE_ENV]: opts.namesFile } : {}),
    // Never inherit a parent's spendable grant or intelligence selection.
    [SUBAGENT_BUDGET_DIR_ENV]: result.budget?.directory ?? "",
    [SUBAGENT_RUN_INTELLIGENCE_ENV]: JSON.stringify(result.intelligence ?? null),
    ...(opts.fallbackModel ? { [SUBAGENT_FALLBACK_MODEL_ENV]: opts.fallbackModel } : {}),
    // Explicit empty values prevent a standalone call from impersonating its parent admission.
    [TREE_CONCURRENCY_DIR_ENV]: opts.treeAdmission?.directory ?? "",
    [WORKER_TOKEN_ENV]: opts.treeAdmission?.token ?? "",
    [BROKER_DIR_ENV]: opts.treeAdmission?.brokerEndpoint?.directory ?? "",
    [BROKER_SECRET_ENV]: opts.treeAdmission?.brokerEndpoint?.secret ?? "",
  });
}
