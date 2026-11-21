import type { Item } from "../store";

export type ToolItem = Extract<Item, { kind: "tool" }>;
export type Entry = { kind: "group"; id: string; tools: ToolItem[] } | Exclude<Item, { kind: "tool" }>;

/** Fold each run of consecutive tool items into one group; everything else is left alone. */
export function groupItems(items: Item[]): Entry[] {
  const out: Entry[] = [];
  for (const item of items) {
    if (item.kind !== "tool") {
      out.push(item);
      continue;
    }
    const last = out[out.length - 1];
    if (last?.kind === "group") last.tools.push(item);
    else out.push({ kind: "group", id: item.id, tools: [item] });
  }
  return out;
}

/** "3 subagents" when every call is a subagent, otherwise "4 steps". */
export function groupLabel(tools: ToolItem[]): string {
  const n = tools.length;
  return tools.every((t) => t.name === "subagent") ? `${n} subagent${n === 1 ? "" : "s"}` : `${n} step${n === 1 ? "" : "s"}`;
}
