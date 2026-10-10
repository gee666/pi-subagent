import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonlFramer } from "../runner/jsonl-framer.js";

test("framing preserves LF records, blank lines and CRLF across chunks", () => {
  const lines: string[] = [];
  const framer = new JsonlFramer((line) => lines.push(line));
  for (const chunk of ["first\r", "\n\nsecond\nthird", "\r\nlast\r"]) framer.write(Buffer.from(chunk));
  assert.deepEqual(lines, ["first", "", "second", "third"]);
  framer.end();
  assert.deepEqual(lines, ["first", "", "second", "third", "last"]);
  framer.end();
  framer.write(Buffer.from("ignored after EOF\n"));
  assert.equal(lines.length, 5, "end is idempotent and closes the framer");
});

test("one-byte UTF-8 fragments preserve Unicode separators inside JSON strings", () => {
  const lines: string[] = [];
  const framer = new JsonlFramer((line) => lines.push(line));
  const first = JSON.stringify({ text: "λ 😀 終 \u2028 \u2029" });
  const last = JSON.stringify({ text: "final 😀" });
  for (const byte of Buffer.from(`${first}\r\n${last}`)) framer.write(Buffer.from([byte]));
  framer.end();
  assert.deepEqual(lines, [first, last]);
  assert.deepEqual(JSON.parse(lines[0]), { text: "λ 😀 終 \u2028 \u2029" });
});

test("EOF flushes incomplete decoder bytes once and ignores whitespace-only tails", () => {
  const lines: string[] = [];
  const framer = new JsonlFramer((line) => lines.push(line));
  framer.write(Buffer.from([0x61, 0xf0, 0x9f]));
  framer.end();
  framer.end();
  assert.deepEqual(lines, ["a\ufffd"]);

  const empty = new JsonlFramer((line) => lines.push(line));
  empty.write(Buffer.from(" \t\r"));
  empty.end();
  assert.deepEqual(lines, ["a\ufffd"]);
});

for (const terminated of [false, true]) {
  test(`large ${terminated ? "terminated" : "final"} records scan only incoming fragments`, (t) => {
    const lines: string[] = [];
    const framer = new JsonlFramer((line) => lines.push(line));
    const fragment = Buffer.from("x".repeat(1024));
    const count = 2048;
    const originalIndexOf = String.prototype.indexOf;
    let searchedChars = 0;
    let largestSearch = 0;
    t.mock.method(String.prototype, "indexOf", function (this: string, search: string, start = 0) {
      if (search === "\n") {
        searchedChars += this.length - start;
        largestSearch = Math.max(largestSearch, this.length);
      }
      return originalIndexOf.call(this, search, start);
    });
    for (let i = 0; i < count; i++) framer.write(fragment);
    assert.deepEqual(lines, [], "partial records must not be emitted");
    if (terminated) framer.write(Buffer.from("\nnext\n"));
    framer.end();
    t.mock.restoreAll();

    assert.equal(largestSearch, fragment.length, "never search the accumulated record again");
    assert.ok(searchedChars <= count * fragment.length + 12, "newline scanning must grow linearly");
    assert.equal(lines[0], "x".repeat(count * fragment.length));
    assert.deepEqual(lines.slice(1), terminated ? ["next"] : []);
  });
}
