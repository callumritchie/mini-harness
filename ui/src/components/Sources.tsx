import { useState } from "react";
import type { Source } from "../protocol";
import { useStore } from "../store";
import { Icon } from "./Icon";

/** What a score means, for the tooltip: the fused rank, and the raw scores of the rankings that found the passage. */
function scoreTitle(s: Source): string {
  if (s.score < 0.01) return "Score near 0: the words searched for are in almost every passage, so they barely tell passages apart";
  const parts = [`Score ${s.score.toFixed(2)} (1 = first in every ranking used; only comparable within this search)`];
  if (s.bm25 != null) parts.push(`keyword match (BM25) ${s.bm25.toFixed(2)}`);
  if (s.cosine != null) parts.push(`meaning (cosine similarity) ${s.cosine.toFixed(2)}`);
  return parts.join(" · ");
}

/** The passages a search_docs call found, best first: where each is, how well it matched next to the best one, its text on
 *  request, and a way to open it in the Files tab at those lines. Snippets are file text: shown as text, never as markup. */
export function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const patch = useStore((s) => s.patch);
  const ranked = [...sources].sort((a, b) => b.score - a.score);
  const top = Math.max(...ranked.map((s) => s.score), 0);
  const show = (s: Source) => patch({ rightTab: "files", rightOpen: true, selectedFile: s.path, selectedRange: { start: s.start_line, end: s.end_line } });
  return (
    <ol className="sources" aria-label="Passages found">
      {ranked.map((s, i) => {
        const where = `${s.path}:${s.start_line}–${s.end_line}`;
        const share = top > 0 ? s.score / top : 1;
        const expanded = open === s.chunk_id;
        return (
          <li key={s.chunk_id} className={`source ${expanded ? "open" : ""}`}>
            <div className="source-head">
              <button className="btn-icon source-toggle" onClick={() => setOpen(expanded ? null : s.chunk_id)} aria-expanded={expanded}
                aria-label={`${expanded ? "Hide" : "Show"} the passage ${where}`}>
                <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
              </button>
              <span className="source-rank">{i + 1}</span>
              <button className="source-where" onClick={() => show(s)} title={`Open ${where} in Files`}>{where}</button>
              {s.match && s.match !== "keyword" && <span className={`chip source-match ${s.match}`}>{s.match === "both" ? "words + meaning" : "meaning"}</span>}
              <span className="source-score" title={scoreTitle(s)}>
                <span className="source-bar" aria-hidden><span style={{ width: `${Math.round(Math.max(share, 0.04) * 100)}%` }} /></span>
                <span className="source-num">{s.score < 0.01 ? "<0.01" : s.score.toFixed(2)}</span>
              </span>
            </div>
            {expanded && <pre className="source-snippet">{s.snippet}</pre>}
          </li>
        );
      })}
    </ol>
  );
}
