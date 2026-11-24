import { useState } from "react";
import type { Candidate, SearchTrace, Source } from "../protocol";
import { WORDS, count } from "../lib/knowledgeWords";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { splitPath } from "./PathLabel";

/** Where a run of lines sits in its file, as a thin bar the length of the file. Several runs can share one bar (a whole turn). */
export function FileBar({ lines, runs, label }: { lines: number; runs: { start: number; end: number; key: string }[]; label: string }) {
  const total = Math.max(lines, ...runs.map((r) => r.end), 1);
  return (
    <span className="file-bar" role="img" aria-label={label}>
      {runs.map((r) => (
        <span key={r.key} style={{ left: `${((r.start - 1) / total) * 100}%`, width: `${Math.max(1.5, ((r.end - r.start + 1) / total) * 100)}%` }} />
      ))}
    </span>
  );
}

const openLines = (s: { path: string; start_line: number; end_line: number }) =>
  useStore.getState().patch({ rightTab: "files", rightOpen: true, selectedFile: s.path, selectedRange: { start: s.start_line, end: s.end_line } });

/** A long file name, allowed to break after _ . - (never mid-word). */
export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[_.\-])/);
  return <>{parts.map((p, i) => <span key={i}>{p}{i < parts.length - 1 && <wbr />}</span>)}</>;
}

const MATCH = { both: "keyword + meaning", keyword: "keyword", meaning: "meaning" } as const;

/** One result: its file and lines first (never cut), then where it sits in the file, or how each ranking placed it. */
function Row({ s, n, view, pool, full }: { s: Source; n: number; view: "where" | "how"; pool: number; full: boolean }) {
  const [text, setText] = useState(false);
  const { base, dir } = splitPath(s.path);
  const lines = s.file_lines ?? s.end_line;
  return (
    <li className="rc-row">
      <div className="rc-head">
        <span className="rc-n">{n}</span>
        <span className="rc-main">
          <button className="rc-where" onClick={() => openLines(s)} title={`Open ${s.path}:${s.start_line}–${s.end_line} in Files`}>
            <span className="rc-base"><Breakable text={base} /></span> <span className="rc-lines">{s.start_line}–{s.end_line}</span>
          </button>
          {s.match && <span className={`chip rc-match ${s.match}`}>{MATCH[s.match]}</span>}
          {s.is_test && <span className="chip" title="From a test file: counted at 60%, because tests repeat words as sample text">test</span>}
        </span>
        <button className="btn-icon rc-text" onClick={() => setText(!text)} aria-expanded={text} aria-label={`${text ? "Hide" : "Show"} the text of ${base} ${s.start_line}–${s.end_line}`}>
          <Icon name={text ? "chevron-down" : "chevron-right"} size={12} />
        </button>
      </div>
      {view === "where" ? (
        <div className="rc-sub">
          <FileBar lines={lines} runs={[{ start: s.start_line, end: s.end_line, key: s.chunk_id }]}
            label={`Lines ${s.start_line}–${s.end_line} of ${lines}`} />
          <span className="rc-meta">{`${s.end_line - s.start_line + 1} of ${lines.toLocaleString()} lines`}{dir && <> · <span className="rc-dir" title={s.path}>{dir}</span></>}</span>
          {s.heading && <span className="rc-meta rc-heading" title={s.heading}>§ {s.heading}</span>}
        </div>
      ) : (
        <div className="rc-sub rc-ranks">
          <Rank way="keyword" rank={s.keyword_rank} pool={pool} full={full} />
          <Rank way="meaning" rank={s.meaning_rank} pool={pool} full={full} />
        </div>
      )}
      {text && <pre className="source-snippet">{s.snippet}</pre>}
    </li>
  );
}

/** Its place in one ranking. `full`: that ranking listed every chunk it matched (fewer than its list holds), so missing means no match. */
function Rank({ way, rank, pool, full }: { way: "keyword" | "meaning"; rank?: number | null; pool: number; full: boolean }) {
  return (
    <span className={`rc-rank ${way}`}>
      <span className="rc-meter" aria-hidden><span style={{ width: rank ? `${((pool - rank + 1) / pool) * 100}%` : "0%" }} /></span>
      <span>{rank ? `${way} #${rank}` : full ? `no ${way} match` : `not in ${way}'s top ${pool}`}</span>
    </span>
  );
}

/** "Why these?": each ranking's own top list side by side, with the kept results marked by their number in both. */
export function WhyRanking({ trace, sources }: { trace: SearchTrace; sources: Source[] }) { // sources: best first, as numbered above
  const [all, setAll] = useState(false);
  const kept = (c: Candidate) => sources.findIndex((s) => (s.chunk_ids ?? [s.chunk_id]).includes(c.chunk_id));
  const lists = [["keyword", trace.candidates?.keyword], ["meaning", trace.candidates?.meaning]] as const;
  const longest = Math.max(...lists.map(([, l]) => l?.length ?? 0));
  return (
    <div className="why">
      <p className="why-note">{trace.searched > trace.pool ? `Each way ranks all ${count(trace.searched, WORDS.snippet)} and lists its best ${trace.pool}. `
        : `Each way ranks the ${count(trace.searched, WORDS.snippet)} and lists the ones it matches. `}Everything listed is then scored both ways and
        the two scores are averaged, so a result one way missed still counts. Numbered rows are the results kept.</p>
      <div className="why-cols">
        {lists.map(([way, list]) => (
          <div key={way} className={`why-col ${way}`}>
            <div className="why-h">{way === "keyword" ? "By keyword" : "By meaning"}</div>
            {list == null ? <p className="why-off">{way === "meaning" ? "Search by meaning wasn't used for this search." : "Not used."}</p> : (
              <ol>
                {list.slice(0, all ? undefined : 10).map((c) => {
                  const k = kept(c);
                  return (
                    <li key={c.chunk_id} className={k >= 0 ? "kept" : ""}>
                      <span className="why-rank">{c.rank}</span>
                      <button className="why-path" onClick={() => openLines(c)} title={`${c.path}:${c.start_line}–${c.end_line}`}>
                        {splitPath(c.path).base}<span className="why-line">:{c.start_line}</span>
                      </button>
                      {k >= 0 && <span className="why-kept" aria-label={`kept as result ${k + 1}`}>{k + 1}</span>}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        ))}
      </div>
      {longest > 10 && <button className="btn-text why-more" onClick={() => setAll(!all)}>{all ? "Show the top 10" : `Show all ${longest}`}</button>}
    </div>
  );
}

/** A search_docs result in the chat: what came back and where it sits in each file, or how each ranking placed it; "Why these?"
 *  shows both rankings. */
export function RetrievalCard({ sources, trace, id }: { sources: Source[]; trace?: SearchTrace; id?: string }) {
  const view = useStore((s) => s.retrievalView);
  const patch = useStore((s) => s.patch);
  const [why, setWhy] = useState(false);
  const pool = trace?.pool ?? 20;
  const ranked = [...sources].sort((a, b) => b.score - a.score);
  const files = new Set(sources.map((s) => s.path)).size;
  const meaningOff = trace && trace.asked !== "keyword" && trace.used === "keyword";
  return (
    <div className="retrieval">
      <div className="rc-bar">
        <span className="rc-summary">{count(sources.length, { one: "chunk", many: "chunks" })} from {count(files, { one: "file", many: "files" })}
          {trace && <span className="muted"> · of {trace.searched.toLocaleString()}</span>}{meaningOff && <span className="muted"> · keyword only</span>}</span>
        <div className="seg seg-xs" role="group" aria-label="Show">
          <button className={view === "where" ? "on" : ""} aria-pressed={view === "where"} onClick={() => patch({ retrievalView: "where" })}>Where</button>
          <button className={view === "how" ? "on" : ""} aria-pressed={view === "how"} onClick={() => patch({ retrievalView: "how" })}>How found</button>
        </div>
      </div>
      <ol className="rc-list" aria-label="Chunks found">
        {ranked.map((s, i) => <Row key={s.chunk_id} s={s} n={i + 1} view={view} pool={pool} full={(trace?.searched ?? Infinity) <= pool} />)}
      </ol>
      <div className="rc-foot">
        {trace?.candidates && <button className="btn-text" onClick={() => setWhy(!why)} aria-expanded={why}>{why ? "Hide why" : "Why these?"}</button>}
        {id && <button className="btn-text" onClick={() => patch({ rightTab: "knowledge", rightOpen: true, knowledgeLookup: id })}>See in Knowledge</button>}
      </div>
      {why && trace && <WhyRanking trace={trace} sources={ranked} />}
    </div>
  );
}
