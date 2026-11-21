import type { Item } from "../store";

export type NoticeKind = "retry" | "compacting" | "compacted" | "plain";

/** Notices are plain text from the server; only a few well-known prefixes get their own look, and the text is never changed. */
export function classifyNotice(text: string): NoticeKind {
  const t = text.trim();
  if (/Trying again in/.test(t)) return "retry";
  if (t.startsWith("● compacting")) return "compacting";
  if (/^compacted into a summary/.test(t)) return "compacted";
  return "plain";
}

const compactEnd = (text: string) => /^compacted into a summary|^could not compact/.test(text.trim());

/** The id of a "compacting…" notice that nothing has finished yet (it gets a spinner), or null. */
export function compactingId(items: Item[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "notice") continue;
    if (compactEnd(it.text)) return null;
    if (classifyNotice(it.text) === "compacting") return it.id;
  }
  return null;
}
