import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import type { GraphResult, SearchResult } from "../protocol";
import { useStore } from "../store";
import { GraphCard, kindClass } from "./GraphCard";
import { LookupTrace } from "./LookupTrace";
import { Icon } from "./Icon";
import { RetrievalCard } from "./RetrievalCard";

type Mode = "search" | "connections";
type Name = { name: string; kind: string };

/** Names that match what is typed, for the connections box. Debounced; stale answers are dropped. */
function useSuggestions(text: string, on: boolean) {
  const [names, setNames] = useState<Name[]>([]);
  useEffect(() => {
    const q = text.trim();
    if (!on || q.length < 2) return setNames([]);
    let live = true;
    const t = setTimeout(() => {
      api<{ names: Name[] }>("graph/names", { q }).then((r) => live && setNames(r.names)).catch(() => live && setNames([]));
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [text, on]);
  return names;
}

/** Try what the agent does, with the same tools: search the snippets for a question (search_docs), or look up a name and follow
 *  its connections (explore_graph). Results open in Files at their lines. `autoFocus` for layouts that lead with this box. */
export function KnowledgeSearch({ autoFocus = false }: { autoFocus?: boolean }) {
  const handoffName = useStore((s) => s.knowledgeQuery);
  const handoffSearch = useStore((s) => s.knowledgeSearch);
  const patch = useStore((s) => s.patch);
  const [mode, setMode] = useState<Mode>("search");
  const [text, setText] = useState("");
  const [prefix, setPrefix] = useState<string | null>(null);
  const [depth, setDepth] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ q: string; result: SearchResult } | null>(null);
  const [graph, setGraph] = useState<{ q: string; graph: GraphResult | null } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const names = useSuggestions(text, mode === "connections" && listOpen);

  const search = useCallback((q: string, inPath: string | null) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    api<SearchResult>("search", { q, ...(inPath ? { path_prefix: inPath } : {}) })
      .then((result) => setFound({ q, result }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);
  const lookUp = useCallback((q: string, d: number) => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    setListOpen(false);
    api<{ graph: GraphResult | null }>("graph", { name: q.trim(), depth: String(d) })
      .then((r) => setGraph({ q: q.trim(), graph: r.graph }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);

  // hand-offs from elsewhere: a name picked in a tool card or "See connections"; "Search in this file"
  useEffect(() => {
    if (!handoffName) return;
    setMode("connections");
    setText(handoffName);
    lookUp(handoffName, depth);
    patch({ knowledgeQuery: null });
  }, [handoffName, lookUp, depth, patch]);
  useEffect(() => {
    if (!handoffSearch) return;
    setMode("search");
    setPrefix(handoffSearch.pathPrefix);
    setText(handoffSearch.query);
    if (handoffSearch.query) search(handoffSearch.query, handoffSearch.pathPrefix);
    else input.current?.focus();
    patch({ knowledgeSearch: null });
  }, [handoffSearch, search, patch]);

  const submit = (q = text) => (mode === "search" ? search(q, prefix) : lookUp(q, depth));
  const pick = (n: Name) => { setText(n.name); lookUp(n.name, depth); };
  const onKey = (e: React.KeyboardEvent) => {
    if (mode !== "connections" || !listOpen || !names.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(names.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(-1, a - 1)); }
    else if (e.key === "Escape") setListOpen(false);
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(names[active]); }
  };

  const used = found?.result.mode;
  return (
    <div className="k-ask">
      <div className="segtabs k-modes" role="tablist" aria-label="What to try">
        {(["search", "connections"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? "on" : ""} onClick={() => { setMode(m); setError(null); input.current?.focus(); }}>
            {m === "search" ? "Search chunks" : "Find connections"}
          </button>
        ))}
      </div>
      <p className="k-help">
        {mode === "search"
          ? "Ask in your own words, the way the agent searches when you ask it something. Results are chunks of your files, best first."
          : "Type a function, class, file or heading to see what uses it and what it uses, the way the agent follows the map."}
      </p>
      <form className="k-search" role="search" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="k-combo">
          <input ref={input} className="field" value={text} autoFocus={autoFocus}
            onChange={(e) => { setText(e.target.value); setListOpen(true); setActive(-1); }} onKeyDown={onKey}
            onBlur={() => setTimeout(() => setListOpen(false), 120)}
            placeholder={mode === "search" ? "e.g. where are permissions checked" : "e.g. Controller, check_cancel, README.md"}
            aria-label={mode === "search" ? "Search the chunks" : "Name to look up"}
            role={mode === "connections" ? "combobox" : undefined} aria-expanded={mode === "connections" ? listOpen && names.length > 0 : undefined}
            aria-controls={mode === "connections" ? listId : undefined} aria-autocomplete={mode === "connections" ? "list" : undefined}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} />
          {mode === "connections" && listOpen && names.length > 0 && (
            <ul className="k-suggest" id={listId} role="listbox" aria-label="Names on the map">
              {names.map((n, i) => (
                <li key={n.name} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? "on" : ""}
                  onMouseDown={(e) => { e.preventDefault(); pick(n); }}>
                  <span className={`kind-dot ${kindClass(n.kind)}`} aria-hidden /><span className="k-suggest-name">{n.name}</span><span className="g-kind">{n.kind}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {mode === "connections" && (
          <select className="field" value={depth} aria-label="How far to follow connections"
            onChange={(e) => { const d = Number(e.target.value); setDepth(d); if (graph) lookUp(graph.q, d); }}>
            <option value={1}>Direct</option><option value={2}>2 steps</option><option value={3}>3 steps</option>
          </select>
        )}
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !text.trim()}>
          <Icon name="search" size={12} />{mode === "search" ? "Search" : "Look up"}
        </button>
      </form>
      {mode === "search" && prefix && (
        <div className="k-scope">
          <span className="chip">Only in {prefix.slice(prefix.lastIndexOf("/") + 1)}</span>
          <button className="btn-text" onClick={() => { setPrefix(null); if (found) search(found.q, null); }}>Search everywhere</button>
        </div>
      )}
      {error && <p className="k-error" role="alert">{error}</p>}

      {mode === "search" && found && (
        <div className="k-results" aria-live="polite">
          {found.result.sources.length === 0 && <>
            {found.result.search ? <LookupTrace search={found.result.search} /> : <p className="k-result-head muted">Nothing found for “{found.q}” ({used}).</p>}
            <p className="k-result-head muted">Try other words the files are likely to use, or fewer words.</p>
          </>}
          {found.result.sources.length > 0 && <RetrievalCard sources={found.result.sources} trace={found.result.search} />}
        </div>
      )}
      {mode === "connections" && graph && (
        <div className="k-results" aria-live="polite">
          {!graph.graph
            ? <p className="k-result-head muted">Nothing on the map is called “{graph.q}”. Try part of the name, or search the chunks instead.</p>
            : <><LookupTrace graph={graph.graph} asked={graph.q} /><GraphCard graph={graph.graph} onPick={(n) => { setText(n); lookUp(n, depth); }} /></>}
        </div>
      )}
    </div>
  );
}
