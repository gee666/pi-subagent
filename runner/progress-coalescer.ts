/** Batch-wide leading/trailing throttle. The callback reads current state only when emitted. */
export class ProgressCoalescer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastEmittedAt: number | undefined;
  private pending = false;
  private disposed = false;

  constructor(
    private readonly emit: () => void,
    private readonly intervalMs = 100,
  ) {}

  request(): void {
    if (this.disposed) return;
    this.pending = true;
    const remaining =
      this.lastEmittedAt === undefined ? 0 : Math.max(0, this.intervalMs - (Date.now() - this.lastEmittedAt));
    if (remaining === 0) {
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, remaining);
    }
  }

  /** Completion may bypass the interval to publish the latest pending state. */
  flush(): void {
    if (this.disposed || !this.pending) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = false;
    this.lastEmittedAt = Date.now();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = false;
  }
}
