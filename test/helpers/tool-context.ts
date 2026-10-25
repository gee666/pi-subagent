import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { hostDouble } from "./host-double.js";

export function toolContext(members: Partial<ExtensionToolContext>): ExtensionToolContext {
  return hostDouble<ExtensionToolContext>({
    tools: [],
    async executeTool(name) {
      throw new Error(`Unexpected nested tool execution in test: ${name}`);
    },
    ...members,
  });
}
