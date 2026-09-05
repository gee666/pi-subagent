import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DetailTheme } from "./detail-lines.js";

export function overlayFrame(width: number, theme: DetailTheme) {
  const outerWidth = Math.max(4, width);
  const innerWidth = Math.max(1, outerWidth - 4);
  const dim = (text: string) => theme.fg("dim", text);
  const border = (left: string, text: string, right: string) =>
    dim(left) + text + dim("─".repeat(Math.max(0, outerWidth - 2 - visibleWidth(text)))) + dim(right);
  return {
    innerWidth,
    top: (title: string) =>
      border("┌", theme.bold(theme.fg("accent", truncateToWidth(` ${title} `, outerWidth - 2))), "┐"),
    row: (text: string, marker = " ") => {
      const clipped = truncateToWidth(text, innerWidth);
      return `${dim("│")}${marker}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${dim("│")}`;
    },
    bottom: (footer: string) => border("└", dim(` ${truncateToWidth(footer, Math.max(1, outerWidth - 4))} `), "┘"),
    fit: (lines: string[]) => lines.map((line) => truncateToWidth(line, Math.max(0, width), "")),
  };
}
