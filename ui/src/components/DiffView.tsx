import { useMemo, useState } from "react";
import { diffRows, type DiffRow } from "../lib/diff";

/** Split diff rows into hunks at the folded gaps, each with a "@@ -a,b +c,d @@" header built from its own line numbers. */
export function hunks(rows: DiffRow[]): { header: string; rows: DiffRow[] }[] {
  const out: { header: string; rows: DiffRow[] }[] = [];
  let cur: DiffRow[] = [];
  const flush = () => {
    if (!cur.length) return;
    const olds = cur.filter((r) => r.oldNo !== undefined).map((r) => r.oldNo!);
    const news = cur.filter((r) => r.newNo !== undefined).map((r) => r.newNo!);
    const range = (ns: number[]) => (ns.length ? `${ns[0]},${ns.length}` : "0,0");
    out.push({ header: `@@ -${range(olds)} +${range(news)} @@`, rows: cur });
    cur = [];
  };
  for (const r of rows) {
    if (r.type === "gap") flush();
    else cur.push(r);
  }
  flush();
  return out;
}

export function DiffView({ path, before, after }: { path: string; before: string | null; after: string | null }) {
  const rows = useMemo(() => diffRows(before, after), [before, after]);
  const parts = useMemo(() => hunks(rows), [rows]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = parts.map((h) => [h.header, ...h.rows.map((r) => `${r.type === "add" ? "+" : r.type === "del" ? "-" : " "}${r.text}`)].join("\n")).join("\n");
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  };
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="tag">{before === null ? "new file" : "modified"}</span>
        <span className="dmeta">Since the start of this session · latest version</span>
        <button className="btn btn-xs" onClick={copy}>{copied ? "Copied" : "Copy diff"}</button>
      </div>
      <div className="diff-body" role="table" aria-label={`Changes to ${path}`}>
        {parts.map((h, j) => (
          <div key={j}>
            <div className="hunk">{h.header}</div>
            {h.rows.map((r, i) => (
              <div key={i} className={`row ${r.type}`}>
                <span className="no">{r.oldNo ?? ""}</span>
                <span className="no">{r.newNo ?? ""}</span>
                <code>{r.type === "add" ? "+ " : r.type === "del" ? "- " : "  "}{r.text}</code>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
