import { useState } from "react";
import type { Source } from "../protocol";
import { useStore } from "../store";
import { Icon } from "./Icon";

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
              <span className="source-score" title={s.score < 0.01
                ? "Score near 0: the words searched for are in almost every passage, so they barely tell passages apart"
                : `Score ${s.score.toFixed(2)}: keyword match (BM25), only comparable within this search`}>
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
