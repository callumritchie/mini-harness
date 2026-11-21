import { useMemo, useState } from "react";
import { diffRows, diffStats } from "../lib/diff";
import { languageFor } from "../lib/lang";
import { CodeLine } from "./Code";

export function DiffView({ path, before, after }: { path: string; before: string | null; after: string | null }) {
  const rows = useMemo(() => diffRows(before, after), [before, after]);
  const stats = diffStats(rows);
  const lang = languageFor(path);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = rows.map((r) => (r.type === "gap" ? `⋯ ${r.text}` : `${r.type === "add" ? "+" : r.type === "del" ? "-" : " "}${r.text}`)).join("\n");
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  };
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="path">{path}</span>
        <span className="tag">{before === null ? "new file" : "modified"}</span>
        <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span>
        <button className="link copydiff" onClick={copy}>{copied ? "Copied" : "Copy diff"}</button>
      </div>
      <div className="diff-body" role="table" aria-label={`Changes to ${path}`}>
        {rows.map((r, i) =>
          r.type === "gap" ? (
            <div key={i} className="row gap">⋯ {r.text}</div>
          ) : (
            <div key={i} className={`row ${r.type}`}>
              <span className="no">{r.oldNo ?? ""}</span>
              <span className="no">{r.newNo ?? ""}</span>
              <span className="sign">{r.type === "add" ? "+" : r.type === "del" ? "−" : " "}</span>
              <code><CodeLine text={r.text} lang={lang} /></code>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
