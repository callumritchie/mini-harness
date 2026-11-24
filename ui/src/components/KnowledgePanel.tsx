import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { IndexStatus } from "../protocol";
import { lookupTitle, sessionLookups } from "../lib/lookups";
import { useStore } from "../store";
import { GraphCard } from "./GraphCard";
import { Icon } from "./Icon";
import { KnowledgeSearch } from "./KnowledgeSearch";
import { IndexLanes } from "./IndexLanes";
import { IndexProblem } from "./KnowledgeSteps";
import { LookupTrace } from "./LookupTrace";
import { RetrievalCard } from "./RetrievalCard";

/** The index's status: live from the store (index_status events), fetched once if the page has none yet. */
function useIndexStatus() {
  const status = useStore((s) => s.indexStatus);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (status) return;
    api<IndexStatus>("index").then((s) => useStore.getState().patch({ indexStatus: s })).catch((e: Error) => setError(e.message));
  }, [status]);
  return { status, error };
}

/** The agent's lookups in this conversation, newest first: pick one to see its steps (and the steps above light up with its
 *  numbers), or jump back to it in the chat. */
function AgentLookups({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const items = useStore((s) => s.items);
  const patch = useStore((s) => s.patch);
  const lookups = useMemo(() => sessionLookups(items), [items]);
  const current = lookups.find((t) => t.id === selected) ?? null;
  if (!lookups.length) {
    return (
      <p className="k-help k-empty">No lookups yet. Ask the agent about this project (“where is the permission check?”) and each search it
        makes shows here, step by step, and in the chat.</p>
    );
  }
  return (
    <>
      <ul className="k-lookups" role="listbox" aria-label="The agent's lookups">
        {lookups.map((t) => (
          <li key={t.id} role="option" aria-selected={t.id === selected} className={t.id === selected ? "on" : ""}>
            <button className="k-lookup" onClick={() => onSelect(t.id)}>
              <span className="k-lookup-title">{lookupTitle(t)}</span>
              <span className="k-lookup-meta">{t.status === "running" ? "searching…" : t.isError ? "failed" : t.outcome ?? ""}</span>
            </button>
            <button className="btn-text k-link" onClick={() => patch({ revealTool: t.id })}>Show in chat</button>
          </li>
        ))}
      </ul>
      {current && current.status === "done" && !current.isError && (
        <div className="k-results">
          {current.sources?.length ? <RetrievalCard sources={current.sources} trace={current.search} />
            : <>
              <LookupTrace search={current.search} graph={current.graph} asked={typeof current.input.name === "string" ? current.input.name : undefined} />
              {current.graph && <GraphCard graph={current.graph} onPick={(n) => patch({ knowledgeQuery: n })} />}
            </>}
        </div>
      )}
    </>
  );
}

/** What the agent can search and how far the index has got (lanes), what it looked up in this conversation, and a way to run the
 *  same search yourself before asking. */
export function KnowledgePanel() {
  const { status, error } = useIndexStatus();
  const items = useStore((s) => s.items);
  const handoff = useStore((s) => s.knowledgeLookup);
  const ownHandoff = useStore((s) => Boolean(s.knowledgeQuery || s.knowledgeSearch));
  const patch = useStore((s) => s.patch);
  const [selected, setSelected] = useState<string | null>(null);
  const [own, setOwn] = useState(false);
  const ownRef = useRef<HTMLDetailsElement>(null);
  const lookupsRef = useRef<HTMLElement>(null);
  const lookups = useMemo(() => sessionLookups(items), [items]);
  const pick = selected && lookups.some((t) => t.id === selected) ? selected : lookups[0]?.id ?? null; // the newest by default

  useEffect(() => { // "See in Knowledge" / "How" from the chat
    if (!handoff) return;
    setSelected(handoff);
    patch({ knowledgeLookup: null });
    requestAnimationFrame(() => lookupsRef.current?.scrollIntoView?.({ block: "start" })); // its steps and results, not the top of the tab
  }, [handoff, patch]);
  useEffect(() => { // a name picked in a connection list, or "Search in this file": that is a search of your own
    if (!ownHandoff) return;
    setOwn(true);
    requestAnimationFrame(() => ownRef.current?.scrollIntoView?.({ block: "start" }));
  }, [ownHandoff]);

  const problem = <IndexProblem status={status} error={error} />;
  const ok = status && status.available && !status.error;
  return (
    <div className="knowledge">
      {ok ? <IndexLanes status={status} /> : problem}

      <section className="k-section" aria-labelledby="k-lookups-h" ref={lookupsRef}>
        <h3 id="k-lookups-h">The agent's lookups</h3>
        <AgentLookups selected={pick} onSelect={setSelected} />
      </section>

      <details className="k-how k-own" ref={ownRef} open={own} onToggle={(e) => setOwn((e.target as HTMLDetailsElement).open)}>
        <summary><Icon name="chevron-right" size={12} /> Search yourself</summary>
        <p className="k-help">Run the agent's search before you ask: check it can find what you mean, or which words work. Nothing is sent
          anywhere and the agent doesn't see it.</p>
        {own && ok && <KnowledgeSearch />}
      </details>
    </div>
  );
}
