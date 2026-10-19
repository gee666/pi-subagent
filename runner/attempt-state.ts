/** Mutable state shared by one RPC attempt and its event handler. */
export interface AttemptState {
  resolved: boolean;
  receivedFirstEvent: boolean;
  agentSettled: boolean;
  backgroundJobs?: number;
  waitingForChildren?: boolean;
  startupTimedOut: boolean;
  wasAborted: boolean;
  forcedExitCode?: number;
  lastNestedProgressSignature?: string;
  activeToolCallIds: Set<string>;
  /** Each completion removes itself and clears its acknowledgment timer. */
  pendingSteeringRequests?: Map<string, (accepted: boolean) => void>;
  /** A settlement seen before steering preflight has answered. */
  pendingAgentSettled?: boolean;
  stopping?: boolean;
  startupTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
}
