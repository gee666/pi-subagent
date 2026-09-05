import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getDetailChildren, getToolListRows, getTurnTools } from "../detail.js";

import { classifyKey, type KeyAction } from "./overlay-input.js";
import { PagerView } from "./pager-view.js";
export class SubagentPager extends PagerView {
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
        const parent = this.parentStack.pop();
        if (!parent) return;
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
      case "left":
        this.setTurn(-1);
        break;
      case "right":
        this.setTurn(1);
        break;
      case "tools":
        if (getTurnTools(this.detail.blocks[this.turnIndex]).length > 0) this.setMode("tools");
        break;
      case "children":
        if (getDetailChildren(this.detail).length > 0) this.setMode("children");
        break;
      default:
        this.handleScrollAction(action);
    }
  }

  private handleToolsAction(action: KeyAction): void {
    const rows = getToolListRows(this.detail.blocks[this.turnIndex]);
    switch (action) {
      case "up":
        this.toolRow -= 1;
        this.dirty = true;
        break;
      case "down":
        this.toolRow += 1;
        this.dirty = true;
        break;
      case "page-up":
        this.toolRow -= Math.max(1, this.viewport - 2);
        this.dirty = true;
        break;
      case "page-down":
        this.toolRow += Math.max(1, this.viewport - 2);
        this.dirty = true;
        break;
      case "home":
        this.toolRow = 0;
        this.dirty = true;
        break;
      case "end":
        this.toolRow = Math.max(0, rows.length - 1);
        this.dirty = true;
        break;
      case "enter": {
        const row = rows[this.toolRow];
        if (!row) break;
        if (row.kind === "child") this.openChild(row.child.name);
        else this.setMode("tool-detail");
        break;
      }
      case "left":
        this.setMode("turn");
        break;
    }
    this.clamp();
    this.ensureSelectedToolVisible();
  }

  private handleChildrenAction(action: KeyAction): void {
    const children = getDetailChildren(this.detail);
    switch (action) {
      case "up":
        this.childIndex -= 1;
        this.dirty = true;
        break;
      case "down":
        this.childIndex += 1;
        this.dirty = true;
        break;
      case "page-up":
        this.childIndex -= Math.max(1, this.viewport - 2);
        this.dirty = true;
        break;
      case "page-down":
        this.childIndex += Math.max(1, this.viewport - 2);
        this.dirty = true;
        break;
      case "home":
        this.childIndex = 0;
        this.dirty = true;
        break;
      case "end":
        this.childIndex = Math.max(0, children.length - 1);
        this.dirty = true;
        break;
      case "enter":
        this.enterSelectedChild();
        return;
      case "left":
        this.setMode("turn");
        return;
    }
    this.clamp();
    const line = this.childIndex + 2;
    if (line < this.scroll) this.scroll = line;
    if (line >= this.scroll + this.viewport) this.scroll = line - this.viewport + 1;
  }

  private enterSelectedChild(): void {
    this.openChild(getDetailChildren(this.detail)[this.childIndex]?.name);
  }

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
      case "up":
        this.scroll -= 1;
        break;
      case "down":
        this.scroll += 1;
        break;
      case "page-up":
        this.scroll -= Math.max(1, this.viewport - 1);
        break;
      case "page-down":
        this.scroll += Math.max(1, this.viewport - 1);
        break;
      case "home":
        this.scroll = 0;
        break;
      case "end":
        this.scroll = this.maxScroll();
        break;
    }
  }
}
