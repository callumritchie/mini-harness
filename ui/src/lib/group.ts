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

/** "3 subagents" when every call is a subagent, otherwise "4 steps"; "Ran … in parallel" only when the server says they ran together. */
export function groupLabel(tools: ToolItem[]): string {
  const n = tools.length;
  const what = tools.every((t) => t.name === "subagent") ? `${n} subagent${n === 1 ? "" : "s"}` : `${n} step${n === 1 ? "" : "s"}`;
  const parallel = n > 1 && tools[0].group != null && tools.every((t) => t.group === tools[0].group);
  return parallel ? `Ran ${what} in parallel` : what;
}
