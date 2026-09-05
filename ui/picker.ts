import { overlayFrame } from "./frame.js";
import { Key, matchesKey, fuzzyFilter } from "@earendil-works/pi-tui";
import type { DetailTheme } from "../detail.js";
export interface PickerItem {
  name: string;
  agent: string;
  task?: string;
}

export function filterPickerItems(items: PickerItem[], query: string): PickerItem[] {
  const trimmed = query.trim();
  if (!trimmed) return items;
  const byName = fuzzyFilter(items, trimmed, (item) => item.name);
  const byEverything = fuzzyFilter(items, trimmed, (item) => `${item.name} ${item.agent} ${item.task ?? ""}`);
  const seen = new Set(byName);
  return [...byName, ...byEverything.filter((item) => !seen.has(item))];
}

export interface PickerOptions {
  items: PickerItem[];
  getRows: () => number;
  theme: DetailTheme;
  requestRender: () => void;
  onPick: (name: string | undefined) => void;
}

export class SubagentPicker {
  private readonly options: PickerOptions;
  private query = "";
  private filtered: PickerItem[];
  private selected = 0;
  private scroll = 0;
  private viewport = 10;

  constructor(options: PickerOptions) {
    this.options = options;
    this.filtered = options.items;
  }

  invalidate(): void {}

  private clamp(): void {
    this.selected = Math.min(Math.max(0, this.selected), Math.max(0, this.filtered.length - 1));
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + this.viewport) this.scroll = this.selected - this.viewport + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.filtered.length - this.viewport)));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.options.onPick(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.options.onPick(this.filtered[this.selected]?.name);
      return;
    }
    if (matchesKey(data, Key.up)) this.selected -= 1;
    else if (matchesKey(data, Key.down)) this.selected += 1;
    else if (matchesKey(data, Key.pageUp)) this.selected -= Math.max(1, this.viewport - 1);
    else if (matchesKey(data, Key.pageDown)) this.selected += Math.max(1, this.viewport - 1);
    else if (matchesKey(data, Key.home)) this.selected = 0;
    else if (matchesKey(data, Key.end)) this.selected = this.filtered.length - 1;
    else if (data === "\u007f" || data === "\b") {
      this.query = this.query.slice(0, -1);
      this.filtered = filterPickerItems(this.options.items, this.query);
      this.selected = 0;
      this.scroll = 0;
    } else if (data && data.charCodeAt(0) >= 32 && !data.startsWith("\u001b")) {
      this.query += data;
      this.filtered = filterPickerItems(this.options.items, this.query);
      this.selected = 0;
      this.scroll = 0;
    } else {
      return;
    }
    this.clamp();
    this.options.requestRender();
  }

  render(width: number): string[] {
    const { theme } = this.options;
    const frame = overlayFrame(width, theme);
    const rows = Math.max(3, this.options.getRows());
    this.viewport = Math.max(1, Math.floor(rows * 0.9) - 4);
    this.clamp();

    const out = [frame.top(`Expand subagent (${this.filtered.length}/${this.options.items.length})`)];
    out.push(frame.row(`${theme.fg("accent", "Search:")} ${this.query}█`));

    const window = this.filtered.slice(this.scroll, this.scroll + this.viewport);
    for (let index = 0; index < this.viewport; index++) {
      const item = window[index];
      if (!item) {
        out.push(frame.row(""));
        continue;
      }
      const isSelected = this.scroll + index === this.selected;
      const marker = isSelected ? theme.fg("accent", ">") : " ";
      const label = `${item.name} (${item.agent})`;
      const task = item.task ? ` — ${item.task.replace(/\s+/g, " ")}` : "";
      out.push(frame.row(`${marker} ${theme.fg("accent", label)}${theme.fg("dim", task)}`));
    }

    if (this.filtered.length === 0) out[2] = frame.row(theme.fg("warning", "No matching subagent"));
    out.push(frame.bottom("type to search • ↑/↓ select • Enter expand • Esc cancel"));
    return frame.fit(out);
  }
}
