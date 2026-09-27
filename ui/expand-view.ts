import type { DetailTheme, SubagentDetail } from "../detail.js";
import { SubagentPager } from "./pager.js";
import { SubagentPicker, type PickerItem } from "./picker.js";

export interface ExpandViewOptions {
  items: PickerItem[];
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

  constructor(private readonly options: ExpandViewOptions) {
    if (options.detail) {
      this.openDetail(options.detail);
    } else {
      this.picker = new SubagentPicker({
        ...options,
        onPick: (name) => {
          if (!name) options.onClose();
          else {
            const detail = options.resolveDetail(name);
            if (detail) this.openDetail(detail);
          }
        },
      });
    }
  }

  private openDetail(detail: SubagentDetail): void {
    this.pager = new SubagentPager({
      ...this.options,
      detail,
      onBack: this.picker
        ? () => {
            this.pager = undefined;
          }
        : undefined,
    });
    this.options.requestRender();
  }

  handleInput(data: string): void {
    (this.pager ?? this.picker)?.handleInput(data);
  }

  render(width: number): string[] {
    return (this.pager ?? this.picker)?.render(width) ?? [];
  }

  invalidate(): void {
    this.picker?.invalidate();
    this.pager?.invalidate();
  }
}
