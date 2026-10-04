import { displayIntelligence } from "../intelligence.js";
import { stringValue } from "./value.js";

// A blank agent string means the run has no agent type.
export function formatSubagentLabel(identity: { name?: unknown; agent?: unknown; intelligence?: unknown }): string {
  const name = stringValue(identity.name);
  const agent = stringValue(identity.agent);
  const intelligence = stringValue(identity.intelligence);
  const qualifier = [intelligence ? displayIntelligence(intelligence) : "", agent].filter(Boolean).join("/");
  return name ? `${name}${qualifier ? ` (${qualifier})` : ""}` : qualifier || "subagent";
}
