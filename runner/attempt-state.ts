/** Mutable state shared by one RPC attempt and its event handler. */
export interface AttemptState {
  resolved: boolean;
  receivedFirstEvent: boolean;
  agentSettled: boolean;
  startupTimedOut: boolean;
  wasAborted: boolean;
  forcedExitCode?: number;
  lastNestedProgressSignature?: string;
  activeToolCallIds: Set<string>;
  startupTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
}
