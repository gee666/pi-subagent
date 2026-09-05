import type { DetailBlock, DetailEvent, DetailChildRef, SubagentDetail } from "./detail-model.js";
export type TurnToolEvent = Extract<DetailEvent, { type: "tool" | "children" }>;

export function getTurnTools(block: DetailBlock | undefined): TurnToolEvent[] {
  return (
    block?.events.filter((event): event is TurnToolEvent => event.type === "tool" || event.type === "children") ?? []
  );
}

export function getDetailChildren(detail: SubagentDetail): DetailChildRef[] {
  const children = new Map<string, DetailChildRef>();
  for (const block of detail.blocks) {
    for (const event of getTurnTools(block)) {
      if (event.type !== "children") continue;
      for (const child of event.children) {
        const key = child.name
          ? `name:${child.name.toLowerCase()}`
          : `agent:${child.agent.toLowerCase()}:${child.task}`;
        children.set(key, child);
      }
    }
  }
  return [...children.values()];
}

export function getTurnResponse(block: DetailBlock | undefined): string {
  if (!block) return "";
  let finalText: Extract<DetailEvent, { type: "text" }> | undefined;
  for (let index = block.events.length - 1; index >= 0; index--) {
    const event = block.events[index];
    if (event.type === "text" && event.text.trim()) {
      finalText = event;
      break;
    }
  }
  if (!finalText) return "";
  if (finalText.assistantTurn === undefined) return finalText.text.trim();
  return block.events
    .filter(
      (event): event is Extract<DetailEvent, { type: "text" }> =>
        event.type === "text" && event.assistantTurn === finalText.assistantTurn && Boolean(event.text.trim()),
    )
    .map((event) => event.text.trim())
    .join("\n");
}

export type ToolListRow =
  | { kind: "tool"; toolIndex: number; event: TurnToolEvent }
  | { kind: "child"; toolIndex: number; child: DetailChildRef };

export function getToolListRows(block: DetailBlock | undefined): ToolListRow[] {
  const rows: ToolListRow[] = [];
  getTurnTools(block).forEach((event, toolIndex) => {
    rows.push({ kind: "tool", toolIndex, event });
    if (event.type === "children") {
      for (const child of event.children) rows.push({ kind: "child", toolIndex, child });
    }
  });
  return rows;
}
