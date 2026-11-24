import type { Item } from "../store";
import type { ToolItem } from "./group";

/** The agent's lookups: its search_docs and explore_graph calls. The chat explains each one, the reply says what was looked up,
 *  and the Knowledge tab lists them, all in the same words (DESIGN.md, "Knowledge words"). */
export const LOOKUP_TOOLS = new Set(["search_docs", "explore_graph"]);
export const isLookup = (it: Item): it is ToolItem => it.kind === "tool" && LOOKUP_TOOLS.has(it.name);

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** What a lookup was for, in the person's words: "Searched your files for “cache rules”", "Followed the map from Store". */
export function lookupTitle(t: Pick<ToolItem, "name" | "input">): string {
  if (t.name === "search_docs") {
    const where = str(t.input.path_prefix) && str(t.input.path_prefix) !== "." ? ` in ${str(t.input.path_prefix)}` : "";
    return `Searched your files${where} for “${str(t.input.query)}”`;
  }
  return `Followed the map from ${str(t.input.name)}`;
}

/** Every lookup in the conversation, newest first. */
export function sessionLookups(items: Item[]): ToolItem[] {
  return items.filter(isLookup).reverse();
}

/** For each turn that made lookups, the id of the turn's last reply (where "Looked up before answering" goes) and its lookups.
 *  A turn runs from one message of the person's to the next. A turn still running has no line yet. */
export function turnLookups(items: Item[], running: boolean): Map<string, ToolItem[]> {
  const out = new Map<string, ToolItem[]>();
  let tools: ToolItem[] = [];
  let reply: string | null = null;
  const close = () => {
    if (reply && tools.length) out.set(reply, tools);
    tools = [];
    reply = null;
  };
  for (const it of items) {
    if (it.kind === "user") close();
    else if (isLookup(it)) tools.push(it);
    else if (it.kind === "assistant") reply = it.id;
  }
  if (!running) close();
  return out;
}

/** "2 searches, 1 map lookup · 6 snippets from 3 files" */
export function lookupSummary(tools: ToolItem[]): { searches: number; maps: number; snippets: number; files: number; names: number } {
  const searches = tools.filter((t) => t.name === "search_docs").length;
  const paths = new Set<string>();
  let snippets = 0, names = 0;
  for (const t of tools) {
    for (const s of t.sources ?? []) {
      snippets += 1;
      paths.add(s.path);
    }
    if (t.graph) names += t.graph.nodes.length - 1;
  }
  return { searches, maps: tools.length - searches, snippets, files: paths.size, names };
}
