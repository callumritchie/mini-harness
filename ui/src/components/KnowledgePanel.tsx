import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { GraphResult, IndexStatus } from "../protocol";
import { formatCost } from "../lib/lang";
import { useStore } from "../store";
import { GraphCard } from "./GraphCard";
import { Icon } from "./Icon";

function ago(t: number | null | undefined) {
  if (!t) return "not yet";
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(t * 1000).toLocaleTimeString();
}

/** The project's index and knowledge graph: what is in them, the buttons that update them (search by meaning, the model-read
 *  graph with its cost shown first), and a lookup that draws any thing's neighbourhood. */
export function KnowledgePanel() {
  const running = useStore((s) => s.running);
  const turns = useStore((s) => s.info?.turns);
  const estimate = useStore((s) => s.graphEstimate);
  const query = useStore((s) => s.knowledgeQuery);
  const { reindex, estimateGraph, buildGraph, patch } = useStore.getState();
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [depth, setDepth] = useState(1);
  const [found, setFound] = useState<{ name: string; graph: GraphResult | null } | null>(null);
  const [looking, setLooking] = useState(false);

  const load = useCallback(() => {
    api<IndexStatus>("index").then((s) => { setStatus(s); setError(null); }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load, running, turns]);
  const busy = Boolean(status?.building || status?.graph_building || status?.embedding);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 1500); // while something is being built, keep the numbers moving
    return () => clearInterval(t);
  }, [busy, load]);

  const lookUp = useCallback((n: string, d = depth) => {
    const q = n.trim();
    if (!q) return;
    setName(q);
    setLooking(true);
    api<{ graph: GraphResult | null }>("graph", { name: q, depth: String(d) })
      .then((r) => setFound({ name: q, graph: r.graph }))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLooking(false));
  }, [depth]);
  useEffect(() => {
    if (query) {
      lookUp(query);
      patch({ knowledgeQuery: null });
    }
  }, [query, lookUp, patch]);

  if (error && !status) return <div className="cant-wrap"><div className="empty-card"><div className="cant-title">Can't read the index</div><div className="cant-body">{error}</div></div></div>;
  if (!status) return <div className="empty-panel">Loading…</div>;
  if (!status.available) return <div className="empty-panel">The document index needs SQLite with full-text search (FTS5), which this Python does not have.</div>;

  const chunks = status.chunks ?? 0;
  const embedded = status.embedded ?? 0;
  const meaning = !status.embed_installed ? "not installed" : !status.embed_downloaded ? "off" : status.embedder ? `${embedded.toLocaleString()} of ${chunks.toLocaleString()}` : "on";

  return (
    <div className="knowledge">
      <div className="k-stats">
        <div><span className="k-num">{(status.files ?? 0).toLocaleString()}</span><span className="k-label">files</span></div>
        <div><span className="k-num">{chunks.toLocaleString()}</span><span className="k-label">passages</span></div>
        <div><span className="k-num">{(status.entities ?? 0).toLocaleString()}</span><span className="k-label">things</span></div>
        <div><span className="k-num">{(status.edges ?? 0).toLocaleString()}</span><span className="k-label">links</span></div>
      </div>
      <p className="k-line muted">
        Updated {ago(status.last_sync)}{status.building ? " · indexing…" : ""}{status.graph_building ? " · building the graph…" : ""}
      </p>

      <section className="k-section">
        <h3>Search by meaning <span className="chip">{meaning}</span></h3>
        {status.embedding && (
          <div className="k-progress" role="progressbar" aria-valuemin={0} aria-valuemax={status.embedding.total} aria-valuenow={status.embedding.done}>
            <span style={{ width: `${Math.round((100 * status.embedding.done) / Math.max(1, status.embedding.total))}%` }} />
          </div>
        )}
        {!status.embed_installed && (
          <p className="k-help">Keyword search works now. To also find passages that use different words, install the local model's
            library into the Python running this app: <code>{status.embed_install ?? 'pip install -e ".[rag]"'}</code>, restart, then come back here.</p>
        )}
        {status.embed_installed && !status.embed_downloaded && (
          <>
            <p className="k-help">Downloads <code>{status.embed_model}</code> ({status.embed_size}) once. It runs on this computer: nothing is sent anywhere.</p>
            <button className="btn btn-sm" onClick={() => reindex(false, true)}>Download model &amp; embed</button>
          </>
        )}
        {status.embed_installed && status.embed_downloaded && (
          <button className="btn btn-sm" onClick={() => reindex(false, true)} disabled={Boolean(status.embedding)}>Embed new passages</button>
        )}
      </section>

      <section className="k-section">
        <h3>Knowledge graph</h3>
        <p className="k-help">Built from the code and the Markdown structure for free. A model can also read the prose and add the
          concepts it talks about; that costs money, so you see the estimate first.</p>
        <div className="k-actions">
          <button className="btn btn-sm" onClick={() => reindex(false)}>Update index</button>
          <button className="btn btn-sm" onClick={() => estimateGraph(true)} disabled={running}>Build prose graph…</button>
        </div>
        {estimate && (
          <div className="k-estimate" role="dialog" aria-label="Build the prose graph?">
            {estimate.passages === 0 ? (
              <p>Nothing new to read{estimate.cached ? ` (${estimate.cached} passage(s) were read before and are reused for free)` : ""}.</p>
            ) : (
              <p><strong>{estimate.model}</strong> would read <strong>{estimate.passages.toLocaleString()}</strong> passage{estimate.passages === 1 ? "" : "s"}: about{" "}
                {estimate.input_tokens.toLocaleString()} tokens in and {estimate.output_tokens.toLocaleString()} out, roughly{" "}
                <strong>{estimate.cost == null ? "an unknown amount" : formatCost(estimate.cost, true)}</strong>. The passages are sent to the provider.</p>
            )}
            <div className="k-actions">
              <button className="btn btn-sm" onClick={() => patch({ graphEstimate: null })}>Cancel</button>
              {(estimate.passages > 0 || estimate.cached > 0) && <button className="btn btn-sm btn-primary" onClick={buildGraph} disabled={running}>Build</button>}
            </div>
          </div>
        )}
      </section>

      <section className="k-section">
        <h3>Look something up</h3>
        <form className="k-search" onSubmit={(e) => { e.preventDefault(); lookUp(name); }}>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="A class, function, heading or concept" aria-label="Thing to look up" />
          <select className="field" value={depth} onChange={(e) => { setDepth(Number(e.target.value)); if (found) lookUp(found.name, Number(e.target.value)); }} aria-label="Hops">
            <option value={1}>1 hop</option><option value={2}>2 hops</option><option value={3}>3 hops</option>
          </select>
          <button className="btn-icon" type="submit" aria-label="Look up" disabled={looking}><Icon name="search" /></button>
        </form>
        {found && !found.graph && <p className="muted">Nothing in the graph matches “{found.name}”.</p>}
        {found?.graph && <GraphCard graph={found.graph} onPick={(n) => lookUp(n)} />}
      </section>
    </div>
  );
}
