import type { IndexState, IndexStatus } from "../protocol";

/** The words the UI uses for the agent's search and map, and what each one means, in one place (DESIGN.md, "Knowledge words").
 *  The model's own tool text keeps its words (passages, links); a person reads these. */
export const WORDS = {
  snippet: { one: "chunk", many: "chunks", means: "Files are cut into chunks (60 lines of code, or a Markdown section), so a search returns the right part of a file, not all of it." },
  name: { one: "name", many: "names", means: "Functions, classes, modules, headings and concepts: the things the map knows by name." },
  connection: { one: "connection", many: "connections", means: "How two names relate: calls, imports, defines, contains, mentions. Each one cites the chunk it came from." },
  keyword: { label: "Keyword search", means: "Finds chunks that use the words you type (skip also finds skipped). Always on." },
  meaning: { label: "Search by meaning", means: "Also finds chunks that say the same thing in other words. A small model on this computer: free, nothing is sent anywhere." },
  map: { label: "Map", means: "Names and their connections, read from the code and the Markdown structure. Free, and kept up to date as files change." },
  concepts: { label: "Concepts from docs", means: "A cloud model reads your prose once and adds the ideas it finds. Costs money: you see the estimate first." },
  inferred: { label: "AI-inferred", means: "Found by a model reading the prose, not by reading the code. Its reading, not a fact." },
} as const;

/** "1 chunk", "1,204 chunks" */
export function count(n: number, word: { one: string; many: string }): string {
  return `${n.toLocaleString()} ${n === 1 ? word.one : word.many}`;
}

/** Why a file is not in the agent's search, as a person reads it. Mirrors rag.SKIP_REASONS. */
export const SKIP_TEXT: Record<Exclude<IndexState, "in">, string> = {
  pending: "New since the last update: it will be searchable in a moment",
  capped: "Past the 20,000-file limit: not searched",
  secret: "Looks like it holds secrets: never searched or shown",
  ignored_folder: "In a folder that is never searched (build output, caches)",
  outside: "A link to somewhere outside the project",
  too_large: "Over 2 MB",
  binary: "Not a text file",
  not_utf8: "Not UTF-8 text",
  minified: "Minified or generated (very long lines)",
  unreadable: "Could not be read",
  not_chosen: "You chose not to search this folder or file",
  gitignored: "Left out by the project's .gitignore",
};

/** Short labels for the reasons, for counts ("3 too large"). */
export const SKIP_SHORT: Record<string, string> = {
  secret: "secret", ignored_folder: "build output or cache", outside: "outside the project", too_large: "over 2 MB", binary: "not text",
  not_utf8: "not UTF-8", minified: "minified", unreadable: "unreadable", not_chosen: "you left out", gitignored: "in .gitignore",
};

/** Can the agent search this file now? Pending files soon can, so they count as searchable in the tree's numbers. */
export const searchable = (idx: IndexState | undefined) => idx === undefined || idx === "in" || idx === "pending";

/** "just now", "4 min ago", a time, or "never" */
export function ago(t: number | null | undefined): string {
  if (!t) return "never";
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t * 1000).toLocaleString(undefined, { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" });
}

/** The relation as a phrase for each side of a name: "calls" → what it calls / what calls it. */
export const RELATION: Record<string, { out: string; in: string }> = {
  calls: { out: "Calls", in: "Called by" },
  imports: { out: "Imports", in: "Imported by" },
  defines: { out: "Defines", in: "Defined in" },
  inherits: { out: "Inherits from", in: "Inherited by" },
  contains: { out: "Contains", in: "Part of" },
  links_to: { out: "Links to", in: "Linked from" },
  mentions: { out: "Mentions", in: "Mentioned in" },
};
export const relation = (r: string, outgoing: boolean) =>
  RELATION[r]?.[outgoing ? "out" : "in"] ?? (outgoing ? r.replace(/_/g, " ") : `${r.replace(/_/g, " ")} (from)`);

/** One line on where the index is: building, embedding, adding concepts, or idle. Null when idle. */
export function activity(s: IndexStatus | null): string | null {
  if (!s?.available) return null;
  if (s.building) return "Updating the index";
  if (s.embedding) return `Search by meaning: ${s.embedding.done.toLocaleString()} of ${s.embedding.total.toLocaleString()} chunks`;
  if (s.graph_building) return "Updating the map";
  return null;
}

/** Totals of files left out. */
export function skippedTotal(s: IndexStatus | null): number {
  return Object.values(s?.skipped ?? {}).reduce((a, b) => a + b, 0);
}
