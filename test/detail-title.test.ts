import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildSubagentDetail, type SubagentDetail } from "../detail.js";
import { SubagentPager } from "../ui/pager.js";
import type { SubagentNameRecord } from "../names.js";
import { SUBAGENT_INTELLIGENCE_CUSTOM_TYPE } from "../intelligence.js";

const marker = (intelligence: string | null) => ({
  type: "custom",
  customType: SUBAGENT_INTELLIGENCE_CUSTOM_TYPE,
  data: { intelligence },
});
const user = (content: string) => ({ type: "message", message: { role: "user", content } });
const pagerFor = (detail: SubagentDetail) =>
  new SubagentPager({
    detail,
    getRows: () => 30,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    requestRender() {},
    onClose() {},
  });

test("expanded titles use the original registry or session label, never a later resume label", () => {
  fs.mkdirSync("tmp", { recursive: true });
  const root = fs.mkdtempSync(path.resolve("tmp/detail-title-"));
  const file = path.join(root, "session.jsonl");
  const record: SubagentNameRecord = {
    name: "Margaret",
    agent: "code-writer",
    task: "Initial",
    sessionDir: root,
    ownerSessionId: "parent",
    createdAt: 0,
    forks: {},
  };
  const cases = [
    { label: "senior", entries: [user("Initial")], expected: "Senior/" },
    {
      label: undefined,
      entries: [marker("senior"), user("Initial"), marker("junior"), user("Resume")],
      expected: "Senior/",
    },
    { label: undefined, entries: [marker("sENior"), user("Initial")], expected: "SENior/" },
    { label: undefined, entries: [marker("senior")], expected: "Senior/" },
    { label: undefined, entries: [marker(null), user("Initial"), marker("senior"), user("Resume")], expected: "" },
    { label: undefined, entries: [user("Initial"), marker("senior"), user("Resume")], expected: "" },
    { label: "senior", entries: [], expected: "Senior/" },
    { label: undefined, entries: [], expected: "" },
  ];
  try {
    for (const { label, entries, expected } of cases) {
      fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
      const detail = buildSubagentDetail({ ...record, intelligence: label });
      const pager = pagerFor(detail);
      assert.ok(pager.render(120)[0].includes(`Margaret (${expected}code-writer)`));
      pager.handleInput("\u001b[D");
      assert.ok(pager.render(120)[0].includes(`Margaret (${expected}code-writer)`));
      for (const width of [12, 24, 60]) {
        for (const line of pager.render(width)) assert.ok(visibleWidth(line) <= width);
      }
    }
    // Private-fork views can recover labels from their own copied session metadata.
    const fork = path.join(root, "fork");
    fs.mkdirSync(fork);
    fs.writeFileSync(
      path.join(fork, "session.jsonl"),
      [marker("senior"), user("Initial")].map((entry) => JSON.stringify(entry)).join("\n"),
    );
    const detail = buildSubagentDetail(record, { sessionDir: fork });
    assert.equal(detail.intelligence, "senior");
    assert.match(pagerFor(detail).render(120)[0], /Margaret \(Senior\/code-writer\)/);
    fs.unlinkSync(file);
    assert.match(
      pagerFor(buildSubagentDetail({ ...record, intelligence: "senior" })).render(120)[0],
      /Margaret \(Senior\/code-writer\)/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
