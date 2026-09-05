import { Key, matchesKey, stripTerminalSequences } from "@earendil-works/pi-tui";
export type KeyAction =
  | "close"
  | "up"
  | "down"
  | "left"
  | "right"
  | "page-up"
  | "page-down"
  | "home"
  | "end"
  | "enter"
  | "tools"
  | "children"
  | "search"
  | "search-next"
  | "search-prev"
  | "none";

export function classifyKey(data: string): KeyAction {
  if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) return "close";
  if (matchesKey(data, Key.up) || data === "k") return "up";
  if (matchesKey(data, Key.down) || data === "j") return "down";
  if (matchesKey(data, Key.left) || data === "h") return "left";
  if (matchesKey(data, Key.right) || data === "l") return "right";
  if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("b")))
    return "page-up";
  if (
    matchesKey(data, Key.pageDown) ||
    matchesKey(data, Key.ctrl("d")) ||
    matchesKey(data, Key.ctrl("f")) ||
    matchesKey(data, Key.space)
  )
    return "page-down";
  if (matchesKey(data, Key.home) || data === "g") return "home";
  if (matchesKey(data, Key.end) || data === "G") return "end";
  if (matchesKey(data, Key.enter)) return "enter";
  if (data === "t" || data === "T") return "tools";
  if (data === "c" || data === "C") return "children";
  if (data === "/") return "search";
  if (data === "n") return "search-next";
  if (data === "N") return "search-prev";
  return "none";
}

export function findMatch(lines: string[], needle: string, from: number, direction: 1 | -1): number {
  const wanted = needle.toLowerCase();
  if (!wanted || lines.length === 0) return -1;
  for (let step = 1; step <= lines.length; step++) {
    const index = (from + direction * step + lines.length * (step + 1)) % lines.length;
    if (stripTerminalSequences(lines[index]).toLowerCase().includes(wanted)) return index;
  }
  return -1;
}
