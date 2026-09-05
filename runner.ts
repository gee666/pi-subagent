/** Public subprocess runner API. Implementation modules live in runner/. */
export type { RunAgentOptions, RunningSubagentHandle, RunningSubagentStartedCallback } from "./runner/options.js";
export type { RuntimeLaunchCommand } from "./runner/launch.js";
export { getCurrentRuntimeLaunch, buildChildProcessEnv } from "./runner/launch.js";
export { resolveSubagentModel } from "./runner/arguments.js";
export { processJsonLine } from "./runner/events.js";
export { runAgentSubprocess } from "./runner/single.js";
export { executeParallelSubprocess } from "./runner/parallel.js";
