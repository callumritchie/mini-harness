import { Fragment, useMemo, useState } from "react";
import { diffRows, diffStats, pairChanges, type DiffRow } from "../lib/diff";
import { useStore } from "../store";

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

function Row({ r }: { r: DiffRow }) {
  return (
    <div className={`row ${r.type}`}>
      <span className="no">{r.oldNo ?? ""}</span>
      <span className="no">{r.newNo ?? ""}</span>
      <span className="sign" aria-hidden>{r.type === "add" ? "+" : r.type === "del" ? "−" : ""}</span>
      <code>
        {r.type === "add" && <span className="sr-only">added: </span>}
        {r.type === "del" && <span className="sr-only">removed: </span>}
        {r.parts ? r.parts.map((p, i) => (p.changed ? <mark key={i} className="dchg">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>)) : r.text || " "}
      </code>
    </div>
  );
}

/** The rows of a diff: hunk headers, removed and added lines with the changed words marked, and folded context that opens in place. */
export function DiffRows({ rows, wrap, headers = true }: { rows: DiffRow[]; wrap: boolean; headers?: boolean }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const paired = useMemo(() => pairChanges(rows), [rows]);
  const heads = useMemo(() => hunks(paired).map((h) => h.header), [paired]);
  let h = 0;
  let inHunk = false;
  return (
    <div className={`diff-body ${wrap ? "wrap" : "nowrap"}`} role="table">
      {paired.map((r, i) => {
        if (r.type === "gap") {
          inHunk = false;
          if (open.has(i)) return <Fragment key={i}>{(r.hidden ?? []).map((c, j) => <Row key={j} r={c} />)}</Fragment>;
          return (
            <button key={i} className="gap" onClick={() => setOpen((o) => new Set(o).add(i))} disabled={!r.hidden?.length}>
              ⋯ {r.text}{r.hidden?.length ? " (show)" : ""}
            </button>
          );
        }
        const head = headers && !inHunk ? heads[h++] : null;
        inHunk = true;
        return <Fragment key={i}>{head && <div className="hunk">{head}</div>}<Row r={r} /></Fragment>;
      })}
    </div>
  );
}

export function DiffView({ path, before, after }: { path: string; before: string | null; after: string | null }) {
  const rows = useMemo(() => diffRows(before, after), [before, after]);
  const stats = diffStats(rows);
  const wrap = useStore((s) => s.wrap);
  const toggleWrap = useStore((s) => s.toggleWrap);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = hunks(rows).map((h) => [h.header, ...h.rows.map((r) => `${r.type === "add" ? "+" : r.type === "del" ? "-" : " "}${r.text}`)].join("\n")).join("\n");
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  };
  return (
    <div className="diff" aria-label={`Changes to ${path}`}>
      <div className="diff-head">
        <span className="tag">{before === null ? "new file" : "modified"}</span>
        <span className="dstats"><span className="add">+{stats.added}</span>{before !== null && <> <span className="del">−{stats.removed}</span></>}</span>
        <span className="dmeta">Since the start of this session · latest version</span>
        <button className="btn btn-xs" onClick={toggleWrap} aria-pressed={wrap} title="Wrap long lines">Wrap</button>
        <button className="btn btn-xs" onClick={copy}>{copied ? "Copied" : "Copy diff"}</button>
      </div>
      <DiffRows rows={rows} wrap={wrap} />
    </div>
  );
}
