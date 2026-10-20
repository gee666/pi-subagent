import type { ChildProcess } from "node:child_process";
import type { SingleResult } from "../types.js";
import type { AttemptState } from "./attempt-state.js";
import type { RunAgentOptions } from "./options.js";
import * as fs from "node:fs";
import type { RunningSubagentHandle } from "./options.js";
import { registerBrokerHandle } from "../broker/root.js";

/** Unload only a flushed idle parent whose descendants belong to the external root broker. */
export class AttemptParking {
  requested = false;
  exited = false;
  private poll?: ReturnType<typeof setInterval>;
  constructor(
    private opts: RunAgentOptions,
    private state: AttemptState,
    private proc: ChildProcess,
    private result: SingleResult,
  ) {
    if (opts.treeAdmission?.brokerEndpoint)
      this.poll = setInterval(() => {
        try {
          if (opts.treeAdmission?.parkingRequested) this.park();
        } catch (error) {
          console.error("[pi-subagent] Parent parking is blocked:", error);
        }
      }, 25);
  }
  register(handle: RunningSubagentHandle): void {
    const admission = this.opts.treeAdmission;
    if (admission?.brokerEndpoint) registerBrokerHandle(admission.brokerEndpoint, admission.token, handle);
  }
  waiting(waiting: boolean, fail: () => void): void {
    try {
      this.opts.treeAdmission?.markWaiting(waiting);
      this.opts.onWaitingForChildren?.(waiting);
    } catch (error) {
      this.result.errorMessage = `Global worker admission unavailable: ${error instanceof Error ? error.message : String(error)}`;
      this.result.stopReason = "error";
      this.state.forcedExitCode = 1;
      fail();
    }
  }
  private savedSessionExists(): boolean {
    try {
      return !!this.opts.sessionDir && fs.readdirSync(this.opts.sessionDir).some((file) => file.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }
  park(): boolean {
    const { state, opts } = this;
    if (
      this.requested ||
      state.resolved ||
      state.stopping ||
      !state.waitingForChildren ||
      state.activeToolCallIds.size ||
      state.pendingSteeringRequests?.size ||
      !this.savedSessionExists()
    )
      return false;
    if (!opts.treeAdmission?.requestPark()) return false;
    this.requested = true;
    state.stopping = true;
    state.forcedExitCode = 0;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    // Broker-owned descendants are separate root children, not members of this process group.
    // Do not run extension shutdown hooks, which could cancel durable child jobs.
    try {
      if (process.platform === "win32") this.proc.kill("SIGKILL");
      else if (this.proc.pid) process.kill(-this.proc.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        console.error("[pi-subagent] Could not unload idle parent; its slot remains reserved:", error);
    }
    return true;
  }
  confirmExit(): boolean {
    this.exited = true;
    if (this.proc.pid) this.opts.treeAdmission?.exited(this.proc.pid);
    if (this.requested) {
      this.result.parked = true;
      this.result.idle = true;
    }
    return this.requested;
  }
  dispose(): void {
    const admission = this.opts.treeAdmission;
    if (admission?.brokerEndpoint) registerBrokerHandle(admission.brokerEndpoint, admission.token);
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }
}
