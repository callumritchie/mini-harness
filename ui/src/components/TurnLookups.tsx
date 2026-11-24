import { useState } from "react";
import type { ToolItem } from "../lib/group";
import { WORDS, count } from "../lib/knowledgeWords";
import { useStore } from "../store";
import { shortName } from "./GraphCard";
import { Icon } from "./Icon";
import { splitPath } from "./PathLabel";
import { FileBar } from "./RetrievalCard";

type Run = { start: number; end: number; key: string; from: string; tool: string };

/** Under a reply: what the agent read from the index before answering, by file, each chunk saying which lookup brought it in.
 *  It says "read", not "based on": the model does not say which of these it used. */
export function TurnLookups({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const patch = useStore((s) => s.patch);
  const searches = tools.filter((t) => t.name === "search_docs");
  const maps = tools.filter((t) => t.name === "explore_graph");
  const files = new Map<string, { lines: number; runs: Run[] }>();
  searches.forEach((t, i) => {
    for (const s of t.sources ?? []) {
      const f = files.get(s.path) ?? { lines: s.file_lines ?? s.end_line, runs: [] };
      f.lines = Math.max(f.lines, s.file_lines ?? s.end_line);
      f.runs.push({ start: s.start_line, end: s.end_line, key: `${t.id}:${s.chunk_id}`, from: searches.length > 1 ? `search ${i + 1}` : "the search", tool: t.id });
      files.set(s.path, f);
    }
  });
  const chunks = [...files.values()].reduce((n, f) => n + f.runs.length, 0);
  const parts = [chunks ? `${count(chunks, { one: "chunk", many: "chunks" })} from ${count(files.size, { one: "file", many: "files" })}` : "",
    maps.length ? count(maps.length, { one: "map lookup", many: "map lookups" }) : ""].filter(Boolean);
  const show = (id: string) => patch({ revealTool: id });
  return (
    <div className="turn-lookups">
      <button className="tl-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        <span>{parts.length ? `Read ${parts.join(" · ")}` : `Looked up ${count(tools.length, { one: "thing", many: "things" })} · nothing found`}</span>
      </button>
      {open && (
        <ul className="tl-files">
          {[...files.entries()].map(([path, f]) => {
            const { base, dir } = splitPath(path);
            const runs = [...f.runs].sort((a, b) => a.start - b.start);
            return (
              <li key={path} className="tl-file">
                <div className="tl-name"><span className="tl-base">{base}</span>{dir && <span className="tl-dir" title={path}>{dir}</span>}</div>
                <FileBar lines={f.lines} runs={runs} label={`${runs.length} part(s) of ${f.lines} lines`} />
                <div className="tl-runs">
                  {runs.map((r) => (
                    <span key={r.key} className="tl-run">
                      <button className="g-cite" title={`Open ${path}:${r.start}–${r.end}`}
                        onClick={() => patch({ rightTab: "files", rightOpen: true, selectedFile: path, selectedRange: { start: r.start, end: r.end } })}>
                        {r.start}–{r.end}
                      </button>
                      <button className="btn-text tl-from" onClick={() => show(r.tool)} title="Show this lookup in the chat">{r.from}</button>
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
          {maps.map((t) => (
            <li key={t.id} className="tl-file">
              <div className="tl-name"><Icon name="graph" size={12} />
                <span className="tl-base">{t.graph ? shortName(t.graph.center.name) : String(t.input.name ?? "")}</span>
                <span className="tl-dir">{t.graph ? count(t.graph.edges.length, WORDS.connection) : t.isError ? "failed" : "nothing found"}</span>
                <button className="btn-text tl-from" onClick={() => show(t.id)}>Show in chat</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
