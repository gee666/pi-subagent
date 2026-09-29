import * as fs from "node:fs";
import * as path from "node:path";
import { SUBAGENT_INTELLIGENCE_CUSTOM_TYPE } from "../intelligence.js";
import type { SubagentModelSettings, SubagentNameRecord } from "./name-records.js";
import { isRecord } from "./values.js";

/** Read the first task's settings, never those appended by a later resume. */
export function readOriginalSessionSettings(sessionDir: string): SubagentModelSettings {
  const settings: SubagentModelSettings = {};
  try {
    const files = fs
      .readdirSync(sessionDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ file: path.join(sessionDir, name), at: fs.statSync(path.join(sessionDir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (!files[0]) return settings;
    let started = false;
    for (const line of fs.readFileSync(files[0].file, "utf8").split("\n")) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;
      if (!started && entry.type === "model_change" && typeof entry.modelId === "string") {
        settings.model = typeof entry.provider === "string" ? `${entry.provider}/${entry.modelId}` : entry.modelId;
      }
      if (!started && entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
        settings.thinking = entry.thinkingLevel;
      }
      if (!started && entry.type === "custom" && entry.customType === SUBAGENT_INTELLIGENCE_CUSTOM_TYPE) {
        const label = isRecord(entry.data) ? entry.data.intelligence : undefined;
        if (typeof label === "string") settings.intelligence = label;
        else if (label === null) delete settings.intelligence;
      }
      const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
      if (message?.role === "user") {
        if (started) break;
        started = true;
      }
      if (message?.role === "assistant" && message.provider !== "pi-subagent-resume") {
        if (typeof message.model === "string" && message.model !== "synthetic-tool-call") {
          settings.model =
            typeof message.provider === "string" ? `${message.provider}/${message.model}` : message.model;
        }
        if (typeof message.thinkingLevel === "string") settings.thinking = message.thinkingLevel;
        break;
      }
    }
  } catch {
    // Missing/partial transcripts can still use the settings saved before spawning.
  }
  return settings;
}

/** Recover actual settings from the original, not a private fork. This also covers interrupted launches
 * whose registry still contains requested settings before Pi clamped thinking or resolved a model alias. */
export function originalModelSettings(record: SubagentNameRecord): SubagentModelSettings {
  const recorded = {
    model: record.model,
    thinking: record.thinking,
    intelligence: record.intelligence,
  };
  return { ...recorded, ...readOriginalSessionSettings(record.sessionDir) };
}
