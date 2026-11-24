import { useState } from "react";
import type { IndexStatus } from "../protocol";
import { WORDS, count } from "../lib/knowledgeWords";
import { formatCost } from "../lib/lang";
import { useStore } from "../store";
import { Icon } from "./Icon";

/** The search-by-meaning setup, inline: install the library, download the model, or how far embedding has got. */
export function MeaningSetup({ status }: { status: IndexStatus }) {
  const reindex = useStore((s) => s.reindex);
  const [copied, setCopied] = useState(false);
  const chunks = status.chunks ?? 0;
  if (status.embedding) {
    const { done, total } = status.embedding;
    return (
      <div className="k-setup">
        <div className="k-progress" role="progressbar" aria-label="Embedding chunks" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ transform: `scaleX(${done / Math.max(1, total)})` }} />
        </div>
        <span className="k-help">{done.toLocaleString()} of {total.toLocaleString()} new chunks. Searches use what's done so far.</span>
      </div>
    );
  }
  if (!status.embed_installed) {
    const cmd = status.embed_install ?? 'pip install -e ".[rag]"';
    return (
      <div className="k-setup">
        <ol className="k-checklist">
          <li>Install the library into the Python that runs Mini Harness:
            <span className="k-cmd"><code>{cmd}</code>
              <button className="btn-icon" aria-label="Copy the command" title={copied ? "Copied" : "Copy"}
                onClick={() => { void navigator.clipboard?.writeText(cmd).then(() => setCopied(true), () => undefined); }}>
                <Icon name={copied ? "check" : "copy"} size={12} />
              </button>
            </span>
          </li>
          <li>Restart Mini Harness. The model ({status.embed_size ?? "about 130 MB"}) then downloads on its own, once.</li>
        </ol>
      </div>
    );
  }
  if (!status.embed_downloaded) {
    return (
      <div className="k-setup">
        <span className="k-help">The model (<code>{status.embed_model}</code>, {status.embed_size}) downloads on its own when the app starts. If that
          failed (offline?), try again now. Until then, searches use keywords alone.</span>
        <button className="btn btn-sm" onClick={() => reindex(false, true)}>Download now</button>
      </div>
    );
  }
  const embedded = status.embedded;
  if (embedded != null && embedded < chunks) {
    return (
      <div className="k-setup">
        <span className="k-help">{embedded.toLocaleString()} of {count(chunks, WORDS.snippet)} read. New ones are read after each task.</span>
        <button className="btn btn-sm" onClick={() => reindex(false, true)}>Read the rest now</button>
      </div>
    );
  }
  return null;
}

/** "Concepts from docs": the paid model read, behind its estimate. */
export function ConceptsSetup() {
  const running = useStore((s) => s.running);
  const estimate = useStore((s) => s.graphEstimate);
  const { estimateGraph, buildGraph, patch } = useStore.getState();
  if (!estimate) {
    return <button className="btn btn-sm" onClick={() => estimateGraph(true)} disabled={running}>See what it would cost…</button>;
  }
  return (
    <div className="k-estimate" role="dialog" aria-label="Add concepts from docs?">
      {estimate.passages === 0 ? (
        <p>Nothing new to read{estimate.cached ? `: ${count(estimate.cached, WORDS.snippet)} were read before and are reused for free` : ""}.</p>
      ) : (
        <p><strong>{estimate.model}</strong> would read <strong>{count(estimate.passages, { one: "prose chunk", many: "prose chunks" })}</strong>{" "}
          (about {estimate.input_tokens.toLocaleString()} tokens in, {estimate.output_tokens.toLocaleString()} out): roughly{" "}
          <strong>{estimate.cost == null ? "an unknown amount" : formatCost(estimate.cost, true)}</strong>. Those chunks are sent to the provider;
          code is not. {estimate.cached > 0 && `${count(estimate.cached, WORDS.snippet)} read before are reused for free.`}</p>
      )}
      <div className="k-actions">
        <button className="btn btn-sm" onClick={() => patch({ graphEstimate: null })}>Not now</button>
        {estimate.passages > 0 && <button className="btn btn-sm btn-primary" onClick={buildGraph} disabled={running}>Read {estimate.passages.toLocaleString()} and add</button>}
      </div>
    </div>
  );
}

/** What goes where the steps would be when the index can't be shown at all. Null when it can. */
export function IndexProblem({ status, error }: { status: IndexStatus | null; error: string | null }) {
  if (error && !status) return <div className="empty-card"><div className="cant-title">Can't read the index</div><div className="cant-body">{error}</div></div>;
  if (!status) return <div className="empty-panel">Loading…</div>;
  if (!status.available) {
    return <div className="empty-card"><div className="cant-title">Search isn't available</div><div className="cant-body">The agent's search needs SQLite with
      full-text search (FTS5), which this Python doesn't have. The agent still finds things with grep.</div></div>;
  }
  if (status.error) return <div className="empty-card"><div className="cant-title">Can't read the index</div><div className="cant-body">{status.error}</div></div>;
  return null;
}
