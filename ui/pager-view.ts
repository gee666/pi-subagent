import { overlayFrame } from "./frame.js";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  TOOL_LIST_HEADER_LINES,
  getDetailChildren,
  getToolListRows,
  getTurnTools,
  renderChildTreeLines,
  renderToolDetailLines,
  renderTurnOverviewLines,
  renderTurnToolListLines,
  type DetailTheme,
  type SubagentDetail,
} from "../detail.js";

import { findMatch } from "./overlay-input.js";
type ViewMode = "turn" | "tools" | "tool-detail" | "children";

export interface PagerOptions {
  detail: SubagentDetail;
  resolveDetail?: (name: string) => SubagentDetail | undefined;
  getRows: () => number;
  theme: DetailTheme;
  requestRender: () => void;
  onClose: () => void;
}

export class PagerView {
  protected readonly options: PagerOptions;
  protected detail: SubagentDetail;
  protected readonly parentStack: Array<{ detail: SubagentDetail; turnIndex: number }> = [];
  protected mode: ViewMode = "turn";
  protected turnIndex: number;
  protected toolRow = 0;
  protected childIndex = 0;
  protected lines: string[] = [];
  protected lastWidth = -1;
  protected dirty = true;
  protected scroll = 0;
  protected viewport = 10;
  protected searchMode = false;
  protected searchQuery = "";
  protected lastSearch = "";
  protected activeMatchLine = -1;
  protected status = "";

  constructor(options: PagerOptions) {
    this.options = options;
    this.detail = options.detail;
    this.turnIndex = Math.max(0, this.detail.blocks.length - 1);
  }

  invalidate(): void {
    this.lastWidth = -1;
    this.dirty = true;
  }

  protected maxScroll(): number {
    return Math.max(0, this.lines.length - this.viewport);
  }

  protected clamp(): void {
    this.scroll = Math.min(Math.max(0, this.scroll), this.maxScroll());
    const rows = getToolListRows(this.detail.blocks[this.turnIndex]);
    this.toolRow = Math.min(Math.max(0, this.toolRow), Math.max(0, rows.length - 1));
    const children = getDetailChildren(this.detail);
    this.childIndex = Math.min(Math.max(0, this.childIndex), Math.max(0, children.length - 1));
  }

  protected resetView(): void {
    this.scroll = 0;
    this.status = "";
    this.activeMatchLine = -1;
    this.dirty = true;
  }

  protected setTurn(delta: number): void {
    const count = this.detail.blocks.length;
    if (count === 0) return;
    this.turnIndex = Math.min(Math.max(0, this.turnIndex + delta), count - 1);
    this.toolRow = 0;
    this.childIndex = 0;
    this.resetView();
  }

  protected setMode(mode: ViewMode): void {
    this.mode = mode;
    this.resetView();
  }

  protected ensureSelectedToolVisible(): void {
    const line = this.toolRow + TOOL_LIST_HEADER_LINES;
    if (line < this.scroll) this.scroll = line;
    if (line >= this.scroll + this.viewport) this.scroll = line - this.viewport + 1;
    this.clamp();
  }

  protected selectedToolIndex(): number {
    const rows = getToolListRows(this.detail.blocks[this.turnIndex]);
    return rows[this.toolRow]?.toolIndex ?? 0;
  }

  protected handleSearchInput(data: string): void {
    if (data === "\u001b") {
      this.searchMode = false;
      this.searchQuery = "";
      return;
    }
    if (data === "\r" || data === "\n") {
      this.searchMode = false;
      this.lastSearch = this.searchQuery;
      this.searchQuery = "";
      this.activeMatchLine = this.scroll - 1;
      this.jump(1);
      return;
    }
    if (data === "\u007f" || data === "\b") {
      this.searchQuery = this.searchQuery.slice(0, -1);
      return;
    }
    if (data.startsWith("\u001b") || !data || data.charCodeAt(0) < 32) return;
    this.searchQuery += data;
  }

  protected jump(direction: 1 | -1): void {
    if (!this.lastSearch) {
      this.status = "no search term — press / to search";
      return;
    }
    const from = this.activeMatchLine >= 0 ? this.activeMatchLine : this.scroll - direction;
    const index = findMatch(this.lines, this.lastSearch, from, direction);
    if (index < 0) {
      this.status = `not found: ${this.lastSearch}`;
      this.activeMatchLine = -1;
      return;
    }
    this.activeMatchLine = index;
    this.scroll = Math.min(index, this.maxScroll());
    if (this.mode === "tools") {
      const matchedRow = index - TOOL_LIST_HEADER_LINES;
      if (matchedRow >= 0 && matchedRow < getToolListRows(this.detail.blocks[this.turnIndex]).length) {
        this.toolRow = matchedRow;
        this.dirty = true;
      }
    } else if (this.mode === "children") {
      const matchedChild = index - 2;
      if (matchedChild >= 0 && matchedChild < getDetailChildren(this.detail).length) {
        this.childIndex = matchedChild;
        this.dirty = true;
      }
    }
    const matches = this.lines
      .map((line, lineIndex) =>
        stripTerminalSequences(line).toLowerCase().includes(this.lastSearch.toLowerCase()) ? lineIndex : -1,
      )
      .filter((lineIndex) => lineIndex >= 0);
    this.status = `${this.lastSearch} — ${matches.indexOf(index) + 1}/${matches.length}`;
  }

  protected buildLines(width: number): string[] {
    const block = this.detail.blocks[this.turnIndex];
    if (this.mode === "turn") {
      return renderTurnOverviewLines(this.detail, this.turnIndex, width, this.options.theme);
    }
    if (this.mode === "tools") {
      return renderTurnToolListLines(block, this.toolRow, width, this.options.theme);
    }
    if (this.mode === "children") {
      return renderChildTreeLines(getDetailChildren(this.detail), this.childIndex, width, this.options.theme);
    }
    const toolIndex = this.selectedToolIndex();
    return renderToolDetailLines(getTurnTools(block)[toolIndex], toolIndex, width, this.options.theme);
  }

  protected title(): string {
    const turn = `turn ${this.turnIndex + 1}/${Math.max(1, this.detail.blocks.length)}`;
    const suffix =
      this.mode === "turn"
        ? turn
        : this.mode === "tools"
          ? `${turn} • tools`
          : this.mode === "children"
            ? "children"
            : `${turn} • tool ${this.selectedToolIndex() + 1}`;
    return `${this.detail.name} (${this.detail.agent}) • ${suffix}`;
  }

  protected footer(): string {
    if (this.searchMode) return `Search: ${this.searchQuery}█   Enter find • Esc cancel`;
    if (this.status) return `${this.status}   n/N next/previous • / new search`;
    const position = `${this.scroll + 1}-${Math.min(this.lines.length, this.scroll + this.viewport)}/${this.lines.length}`;
    if (this.mode === "turn") {
      const back = this.parentStack.length > 0 ? "Esc parent" : "Esc close";
      return `${position}   ←/→ turn • T tools • C children • / search • ${back}`;
    }
    if (this.mode === "tools")
      return `${position}   ↑/↓ row • Enter inspect/expand child • / search • Esc back • q close`;
    if (this.mode === "children") return `${position}   ↑/↓ select • Enter expand • / search • Esc back • q close`;
    return `${position}   ↑/↓ scroll • / search • Esc back • q close`;
  }

  render(width: number): string[] {
    const { theme } = this.options;
    const frame = overlayFrame(width, theme);
    const { innerWidth } = frame;
    if (innerWidth !== this.lastWidth || this.dirty) {
      this.lastWidth = innerWidth;
      this.lines = this.buildLines(innerWidth);
      this.dirty = false;
    }

    const rows = Math.max(3, this.options.getRows());
    const availableHeight = Math.max(3, Math.floor(rows * 0.9));
    this.viewport = Math.max(1, Math.min(Math.max(1, this.lines.length), availableHeight - 2));
    this.clamp();
    if (this.mode === "tools") this.ensureSelectedToolVisible();
    if (this.mode === "children") {
      const line = this.childIndex + 2;
      if (line < this.scroll) this.scroll = line;
      if (line >= this.scroll + this.viewport) this.scroll = line - this.viewport + 1;
      this.clamp();
    }

    const out = [frame.top(this.title())];

    const window = this.lines.slice(this.scroll, this.scroll + this.viewport);
    for (let index = 0; index < this.viewport; index++) {
      const lineIndex = this.scroll + index;
      const raw = window[index] ?? "";
      const marker = lineIndex === this.activeMatchLine ? theme.fg("accent", "›") : " ";
      out.push(frame.row(raw, marker));
    }

    out.push(frame.bottom(this.footer()));
    return frame.fit(out);
  }
}
