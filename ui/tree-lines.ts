import type { TreeNode } from "./tree-model.js";
import { type ThemeFg, formatClockTime, statusEmoji } from "./tree-format.js";
import { formatLiveLogEntry } from "./tree-live.js";
let broadcastNumberingActive = false;

export function setBroadcastNumberingActive(active: boolean): void {
  broadcastNumberingActive = active;
}

export function renderTreeLines(
  nodes: TreeNode[],
  theme: { fg: ThemeFg },
  showOutputPreview: boolean,
  depth = 0,
  prefix = "",
  showFullPrompts = false,
): string[] {
  const lines: string[] = [];

  nodes.forEach((node, index) => {
    const indent = "  ".repeat(depth);
    const number = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
    const numberPrefix = broadcastNumberingActive ? `${number}. ` : "";
    const timePrefix = node.startedAt !== undefined ? `${theme.fg("dim", formatClockTime(node.startedAt))} ` : "";
    let line = `${indent}${numberPrefix}${timePrefix}${statusEmoji(node.status, theme)} ${theme.fg("accent", node.label)}`;
    if (node.meta) line += ` ${theme.fg("dim", node.meta)}`;
    lines.push(line);

    if (showFullPrompts && node.task) {
      const promptLines = node.task.replace(/\r\n?/g, "\n").split("\n");
      promptLines.forEach((promptLine, promptIndex) => {
        const promptLabel = promptIndex === 0 ? "prompt: " : "        ";
        lines.push(`${indent}  ${theme.fg("muted", promptLabel)}${theme.fg("toolOutput", promptLine)}`);
      });
    }

    if (showOutputPreview && node.outputPreview && node.outputPreview.length > 0) {
      for (const outputLine of node.outputPreview) {
        lines.push(`${indent}  ${theme.fg("toolOutput", outputLine)}`);
      }
    }
    if (node.liveActivity && node.liveActivity.length > 0) {
      for (const entry of node.liveActivity) {
        lines.push(`${indent}  ${formatLiveLogEntry(entry, theme)}`);
      }
    }

    if (node.children.length > 0) {
      lines.push(...renderTreeLines(node.children, theme, showOutputPreview, depth + 1, number, showFullPrompts));
    }
  });

  return lines;
}
