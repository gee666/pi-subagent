import type { DetailTheme, SubagentDetail } from "../detail.js";
import { SubagentPager } from "./pager.js";
import { SubagentPicker, type PickerItem } from "./picker.js";

export interface ExpandViewOptions {
  items: PickerItem[];
  getItems?: () => PickerItem[];
  detail?: SubagentDetail;
  resolveDetail: (name: string) => SubagentDetail | undefined;
  getRows: () => number;
  theme: DetailTheme;
  requestRender: () => void;
  onClose: () => void;
}

/** Keep the picker alive while browsing transcripts so Esc restores its search and selection. */
export class SubagentExpandView {
  private readonly picker?: SubagentPicker;
  private pager?: SubagentPager;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly options: ExpandViewOptions) {
    if (options.detail) {
      this.openDetail(options.detail);
    } else {
      this.picker = new SubagentPicker({
        ...options,
        onPick: (name) => {
          if (!name) this.close();
          else {
            const detail = options.resolveDetail(name);
            if (detail) this.openDetail(detail);
          }
        },
      });
      if (options.getItems) {
        this.refreshTimer = setInterval(() => this.refreshItems(), 1000);
        this.refreshTimer.unref?.();
      }
    }
  }

  private refreshItems(): void {
    if (this.disposed || !this.options.getItems) return;
    const items = this.options.getItems();
    if (!this.disposed) this.picker?.setItems(items);
  }

  private close(): void {
    if (this.disposed) return;
    this.dispose();
    this.options.onClose();
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private openDetail(detail: SubagentDetail): void {
    this.pager = new SubagentPager({
      ...this.options,
      detail,
      onClose: () => this.close(),
      onBack: this.picker
        ? () => {
            this.pager = undefined;
            this.refreshItems();
          }
        : undefined,
    });
    this.options.requestRender();
  }

  handleInput(data: string): void {
    if (!this.disposed) (this.pager ?? this.picker)?.handleInput(data);
  }

  render(width: number): string[] {
    return (this.pager ?? this.picker)?.render(width) ?? [];
  }

  invalidate(): void {
    this.picker?.invalidate();
    this.pager?.invalidate();
  }
}
