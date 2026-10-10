import { StringDecoder } from "node:string_decoder";

/** Decode UTF-8 and scan only new fragments for LF, joining once per complete record. */
export class JsonlFramer {
  private readonly decoder = new StringDecoder("utf8");
  private fragments: string[] = [];
  private ended = false;

  constructor(private readonly onLine: (line: string) => void) {}

  write(chunk: Buffer): void {
    if (!this.ended) this.scan(this.decoder.write(chunk));
  }

  /** Flush decoder bytes and the final unterminated record exactly once. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.scan(this.decoder.end());
    if (this.fragments.length === 0) return;
    const line = this.fragments.join("");
    this.fragments = [];
    if (line.trim()) this.emit(line);
  }

  private scan(text: string): void {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        this.fragments.push(text.slice(start));
        return;
      }
      let line = text.slice(start, newline);
      if (this.fragments.length > 0) {
        this.fragments.push(line);
        line = this.fragments.join("");
        this.fragments = [];
      }
      this.emit(line);
      start = newline + 1;
    }
  }

  private emit(line: string): void {
    this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}
