import { readCurrentRegistry } from "./expand-command.js";
import type { ExtensionState } from "./state.js";

export interface MessageRecipient {
  name: string;
  agent?: string;
  intelligence?: string;
}

/** Original launch identity, never inferred from the lead's model or current presets. */
export function resolveMessageRecipient(state: ExtensionState, name: string): MessageRecipient {
  try {
    const record = readCurrentRegistry(state)?.agents[name];
    if (record) return { name: record.name, agent: record.agent, intelligence: record.intelligence };
  } catch {
    // A missing registry must not break historical rendering or live steering.
  }
  return { name };
}
