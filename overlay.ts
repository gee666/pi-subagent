/** Turn-oriented popup for `/subagent-expand <name>`. */

import {
	Key,
	fuzzyFilter,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
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
} from "./detail.js";

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

/** Map a raw terminal input chunk to a pager action. Pure and unit-tested. */
export function classifyKey(data: string): KeyAction {
	if (matchesKey(data, Key.escape) || data === "q" || matchesKey(data, Key.ctrl("c"))) return "close";
	if (matchesKey(data, Key.up) || data === "k") return "up";
	if (matchesKey(data, Key.down) || data === "j") return "down";
	if (matchesKey(data, Key.left) || data === "h") return "left";
	if (matchesKey(data, Key.right) || data === "l") return "right";
	if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("b"))) return "page-up";
	if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d")) || matchesKey(data, Key.ctrl("f")) || matchesKey(data, Key.space)) return "page-down";
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

/** Find the next visible-text line matching `needle`, wrapping around. */
export function findMatch(
	lines: string[],
	needle: string,
	from: number,
	direction: 1 | -1,
): number {
	const wanted = needle.toLowerCase();
	if (!wanted || lines.length === 0) return -1;
	for (let step = 1; step <= lines.length; step++) {
		const index = (from + direction * step + lines.length * (step + 1)) % lines.length;
		if (stripTerminalSequences(lines[index]).toLowerCase().includes(wanted)) return index;
	}
	return -1;
}

type ViewMode = "turn" | "tools" | "tool-detail" | "children";

export interface PagerOptions {
	detail: SubagentDetail;
	resolveDetail?: (name: string) => SubagentDetail | undefined;
	getRows: () => number;
	theme: DetailTheme;
	requestRender: () => void;
	onClose: () => void;
}

export class SubagentPager {
	private readonly options: PagerOptions;
	private detail: SubagentDetail;
	private readonly parentStack: Array<{ detail: SubagentDetail; turnIndex: number }> = [];
	private mode: ViewMode = "turn";
	private turnIndex: number;
	/** Selected row in the tool list (tool rows and child rows are both rows). */
	private toolRow = 0;
	private childIndex = 0;
	private lines: string[] = [];
	private lastWidth = -1;
	private dirty = true;
	private scroll = 0;
	private viewport = 10;
	private searchMode = false;
	private searchQuery = "";
	private lastSearch = "";
	private activeMatchLine = -1;
	private status = "";

	constructor(options: PagerOptions) {
		this.options = options;
		this.detail = options.detail;
		this.turnIndex = Math.max(0, this.detail.blocks.length - 1);
	}

	invalidate(): void {
		this.lastWidth = -1;
		this.dirty = true;
	}

	private maxScroll(): number {
		return Math.max(0, this.lines.length - this.viewport);
	}

	private clamp(): void {
		this.scroll = Math.min(Math.max(0, this.scroll), this.maxScroll());
		const rows = getToolListRows(this.detail.blocks[this.turnIndex]);
		this.toolRow = Math.min(Math.max(0, this.toolRow), Math.max(0, rows.length - 1));
		const children = getDetailChildren(this.detail);
		this.childIndex = Math.min(Math.max(0, this.childIndex), Math.max(0, children.length - 1));
	}

	private resetView(): void {
		this.scroll = 0;
		this.status = "";
		this.activeMatchLine = -1;
		this.dirty = true;
	}

	private setTurn(delta: number): void {
		const count = this.detail.blocks.length;
		if (count === 0) return;
		this.turnIndex = Math.min(Math.max(0, this.turnIndex + delta), count - 1);
		this.toolRow = 0;
		this.childIndex = 0;
		this.resetView();
	}

	private setMode(mode: ViewMode): void {
		this.mode = mode;
		this.resetView();
	}

	private ensureSelectedToolVisible(): void {
		// The list starts with its summary and one blank line; every row is one line.
		const line = this.toolRow + TOOL_LIST_HEADER_LINES;
		if (line < this.scroll) this.scroll = line;
		if (line >= this.scroll + this.viewport) this.scroll = line - this.viewport + 1;
		this.clamp();
	}

	handleInput(data: string): void {
		if (this.searchMode) {
			this.handleSearchInput(data);
			this.options.requestRender();
			return;
		}

		const action = classifyKey(data);
		if (action === "close") {
			if (data === "q" || matchesKey(data, Key.ctrl("c"))) {
				this.options.onClose();
			} else if (this.mode === "tool-detail") {
				this.setMode("tools");
			} else if (this.mode === "tools" || this.mode === "children") {
				this.setMode("turn");
			} else if (this.parentStack.length > 0) {
				const parent = this.parentStack.pop()!;
				this.detail = parent.detail;
				this.turnIndex = parent.turnIndex;
				this.toolRow = 0;
				this.childIndex = 0;
				this.resetView();
			} else {
				this.options.onClose();
			}
			this.options.requestRender();
			return;
		}

		if (action === "search") {
			this.searchMode = true;
			this.searchQuery = "";
			this.status = "";
			this.options.requestRender();
			return;
		}
		if (action === "search-next" || action === "search-prev") {
			this.jump(action === "search-next" ? 1 : -1);
			this.options.requestRender();
			return;
		}

		if (this.mode === "turn") this.handleTurnAction(action);
		else if (this.mode === "tools") this.handleToolsAction(action);
		else if (this.mode === "children") this.handleChildrenAction(action);
		else this.handleDetailAction(action);
		this.clamp();
		this.options.requestRender();
	}

	private handleTurnAction(action: KeyAction): void {
		switch (action) {
			case "left": this.setTurn(-1); break;
			case "right": this.setTurn(1); break;
			case "tools":
				if (getTurnTools(this.detail.blocks[this.turnIndex]).length > 0) this.setMode("tools");
				break;
			case "children":
				if (getDetailChildren(this.detail).length > 0) this.setMode("children");
				break;
			default: this.handleScrollAction(action);
		}
	}

	private handleToolsAction(action: KeyAction): void {
		const rows = getToolListRows(this.detail.blocks[this.turnIndex]);
		switch (action) {
			case "up": this.toolRow -= 1; this.dirty = true; break;
			case "down": this.toolRow += 1; this.dirty = true; break;
			case "page-up": this.toolRow -= Math.max(1, this.viewport - 2); this.dirty = true; break;
			case "page-down": this.toolRow += Math.max(1, this.viewport - 2); this.dirty = true; break;
			case "home": this.toolRow = 0; this.dirty = true; break;
			case "end": this.toolRow = Math.max(0, rows.length - 1); this.dirty = true; break;
			case "enter": {
				const row = rows[this.toolRow];
				if (!row) break;
				// Enter on a child row dives into that subagent; on a tool row it
				// opens the full arguments/result view.
				if (row.kind === "child") this.openChild(row.child.name);
				else this.setMode("tool-detail");
				break;
			}
			case "left": this.setMode("turn"); break;
		}
		this.clamp();
		this.ensureSelectedToolVisible();
	}

	/** Index of the tool owning the selected row (child rows map to their tool). */
	private selectedToolIndex(): number {
		const rows = getToolListRows(this.detail.blocks[this.turnIndex]);
		return rows[this.toolRow]?.toolIndex ?? 0;
	}

	private handleChildrenAction(action: KeyAction): void {
		const children = getDetailChildren(this.detail);
		switch (action) {
			case "up": this.childIndex -= 1; this.dirty = true; break;
			case "down": this.childIndex += 1; this.dirty = true; break;
			case "page-up": this.childIndex -= Math.max(1, this.viewport - 2); this.dirty = true; break;
			case "page-down": this.childIndex += Math.max(1, this.viewport - 2); this.dirty = true; break;
			case "home": this.childIndex = 0; this.dirty = true; break;
			case "end": this.childIndex = Math.max(0, children.length - 1); this.dirty = true; break;
			case "enter": this.enterSelectedChild(); return;
			case "left": this.setMode("turn"); return;
		}
		this.clamp();
		const line = this.childIndex + 2;
		if (line < this.scroll) this.scroll = line;
		if (line >= this.scroll + this.viewport) this.scroll = line - this.viewport + 1;
	}

	private enterSelectedChild(): void {
		this.openChild(getDetailChildren(this.detail)[this.childIndex]?.name);
	}

	/** Replace the view with a named child's own expanded view. */
	private openChild(name: string | undefined): void {
		if (!name) {
			this.status = "This child has no durable name.";
			return;
		}
		const next = this.options.resolveDetail?.(name);
		if (!next) {
			this.status = `Cannot load subagent ${name}.`;
			return;
		}
		this.parentStack.push({ detail: this.detail, turnIndex: this.turnIndex });
		this.detail = next;
		this.turnIndex = Math.max(0, next.blocks.length - 1);
		this.toolRow = 0;
		this.childIndex = 0;
		this.setMode("turn");
	}

	private handleDetailAction(action: KeyAction): void {
		if (action === "left") this.setMode("tools");
		else this.handleScrollAction(action);
	}

	private handleScrollAction(action: KeyAction): void {
		switch (action) {
			case "up": this.scroll -= 1; break;
			case "down": this.scroll += 1; break;
			case "page-up": this.scroll -= Math.max(1, this.viewport - 1); break;
			case "page-down": this.scroll += Math.max(1, this.viewport - 1); break;
			case "home": this.scroll = 0; break;
			case "end": this.scroll = this.maxScroll(); break;
		}
	}

	private handleSearchInput(data: string): void {
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

	private jump(direction: 1 | -1): void {
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
			.map((line, lineIndex) => stripTerminalSequences(line).toLowerCase().includes(this.lastSearch.toLowerCase()) ? lineIndex : -1)
			.filter((lineIndex) => lineIndex >= 0);
		this.status = `${this.lastSearch} — ${matches.indexOf(index) + 1}/${matches.length}`;
	}

	private buildLines(width: number): string[] {
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

	private title(): string {
		const turn = `turn ${this.turnIndex + 1}/${Math.max(1, this.detail.blocks.length)}`;
		const suffix = this.mode === "turn"
			? turn
			: this.mode === "tools"
				? `${turn} • tools`
				: this.mode === "children" ? "children" : `${turn} • tool ${this.selectedToolIndex() + 1}`;
		return `${this.detail.name} (${this.detail.agent}) • ${suffix}`;
	}

	private footer(): string {
		if (this.searchMode) return `Search: ${this.searchQuery}█   Enter find • Esc cancel`;
		if (this.status) return `${this.status}   n/N next/previous • / new search`;
		const position = `${this.scroll + 1}-${Math.min(this.lines.length, this.scroll + this.viewport)}/${this.lines.length}`;
		if (this.mode === "turn") {
			const back = this.parentStack.length > 0 ? "Esc parent" : "Esc close";
			return `${position}   ←/→ turn • T tools • C children • / search • ${back}`;
		}
		if (this.mode === "tools") return `${position}   ↑/↓ row • Enter inspect/expand child • / search • Esc back • q close`;
		if (this.mode === "children") return `${position}   ↑/↓ select • Enter expand • / search • Esc back • q close`;
		return `${position}   ↑/↓ scroll • / search • Esc back • q close`;
	}

	render(width: number): string[] {
		const { theme } = this.options;
		const outerWidth = Math.max(4, width);
		const innerWidth = Math.max(1, outerWidth - 4);
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

		const dim = (text: string) => theme.fg("dim", text);
		const plainTitle = truncateToWidth(` ${this.title()} `, Math.max(1, outerWidth - 2));
		const titleText = theme.bold(theme.fg("accent", plainTitle));
		const topFill = Math.max(0, outerWidth - 2 - visibleWidth(titleText));
		const out: string[] = [dim("┌") + titleText + dim("─".repeat(topFill)) + dim("┐")];

		const window = this.lines.slice(this.scroll, this.scroll + this.viewport);
		for (let index = 0; index < this.viewport; index++) {
			const lineIndex = this.scroll + index;
			const raw = window[index] ?? "";
			const clipped = truncateToWidth(raw, innerWidth);
			const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
			const marker = lineIndex === this.activeMatchLine ? theme.fg("accent", "›") : " ";
			out.push(`${dim("│")}${marker}${clipped}${pad} ${dim("│")}`);
		}

		const footerText = ` ${truncateToWidth(this.footer(), Math.max(1, outerWidth - 4))} `;
		const bottomFill = Math.max(0, outerWidth - 2 - visibleWidth(footerText));
		out.push(dim("└") + dim(footerText) + dim("─".repeat(bottomFill)) + dim("┘"));
		return out;
	}
}

// ---------------------------------------------------------------------------
// Searchable name picker (shown when /subagent-expand is run without a name)
// ---------------------------------------------------------------------------

export interface PickerItem {
	name: string;
	agent: string;
	task?: string;
}

/**
 * Fuzzy-filter picker entries.
 *
 * Name matches rank first (the user almost always searches by name), then
 * matches anywhere in the agent type or task text.
 */
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
		const outerWidth = Math.max(4, width);
		const innerWidth = Math.max(1, outerWidth - 4);
		const rows = Math.max(3, this.options.getRows());
		this.viewport = Math.max(1, Math.floor(rows * 0.9) - 4);
		this.clamp();

		const dim = (text: string) => theme.fg("dim", text);
		const pad = (text: string) => {
			const clipped = truncateToWidth(text, innerWidth);
			return `${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}`;
		};
		const title = truncateToWidth(` Expand subagent (${this.filtered.length}/${this.options.items.length}) `, Math.max(1, outerWidth - 2));
		const styledTitle = theme.bold(theme.fg("accent", title));
		const out: string[] = [dim("┌") + styledTitle + dim("─".repeat(Math.max(0, outerWidth - 2 - visibleWidth(styledTitle)))) + dim("┐")];
		out.push(`${dim("│")} ${pad(`${theme.fg("accent", "Search:")} ${this.query}█`)} ${dim("│")}`);

		const window = this.filtered.slice(this.scroll, this.scroll + this.viewport);
		for (let index = 0; index < this.viewport; index++) {
			const item = window[index];
			if (!item) {
				out.push(`${dim("│")} ${pad("")} ${dim("│")}`);
				continue;
			}
			const isSelected = this.scroll + index === this.selected;
			const marker = isSelected ? theme.fg("accent", ">") : " ";
			const label = `${item.name} (${item.agent})`;
			const task = item.task ? ` — ${item.task.replace(/\s+/g, " ")}` : "";
			out.push(`${dim("│")} ${pad(`${marker} ${theme.fg("accent", label)}${theme.fg("dim", task)}`)} ${dim("│")}`);
		}

		if (this.filtered.length === 0) out[2] = `${dim("│")} ${pad(theme.fg("warning", "No matching subagent"))} ${dim("│")}`;
		const footer = ` ${truncateToWidth("type to search • ↑/↓ select • Enter expand • Esc cancel", Math.max(1, outerWidth - 4))} `;
		out.push(dim("└") + dim(footer) + dim("─".repeat(Math.max(0, outerWidth - 2 - visibleWidth(footer)))) + dim("┘"));
		return out;
	}
}
