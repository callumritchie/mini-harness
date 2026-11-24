import { useState } from "react";
import type { IndexRun, IndexStatus } from "../protocol";
import { SKIP_SHORT, WORDS, ago, count, skippedTotal } from "../lib/knowledgeWords";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { ConceptsSetup, MeaningSetup } from "./KnowledgeSteps";

const TRIGGER: Record<string, string> = {
  start: "When the app started", "after task": "After a task", "agent wrote": "The agent wrote a file", "before search": "Before a search",
  "first choice": "When you chose what to search", "choice changed": "When you changed what to search", "you asked": "When you asked",
};

/** One update, in words: what started it and what it changed. */
export function runLine(r: IndexRun): string {
  const did = [r.added && `${r.added} added`, r.updated && `${r.updated} re-cut`, r.removed && `${r.removed} removed`,
    r.embedded && `${count(r.embedded, { one: "chunk", many: "chunks" })} embedded`].filter(Boolean).join(", ");
  const files = r.paths?.length ? ` (${r.paths.map((p) => p.split("/").pop()).join(", ")})` : "";
  return `${TRIGGER[r.trigger] ?? r.trigger}, ${ago(r.at)}${files}: ${did || "nothing had changed"}`;
}

function Lane({ name, value, sub, busy, warn }: { name: string; value: string; sub?: string; busy?: boolean; warn?: boolean }) {
  return (
    <li className={`lane ${warn ? "warn" : ""}`}>
      <span className="lane-name">{busy && <Spinner size={9} />}{name}</span>
      <span className="lane-value">{value}</span>
      {sub && <span className="lane-sub">{sub}</span>}
    </li>
  );
}

/** The index, top of the Knowledge tab: a status line, then the four stages with their state and the last updates, then why
 *  files are left out and the setup (behind "Details"). */
export function IndexLanes({ status }: { status: IndexStatus }) {
  const patch = useStore((s) => s.patch);
  const reindex = useStore((s) => s.reindex);
  const chooseSearch = useStore((s) => s.chooseSearch);
  const [details, setDetails] = useState(false);
  if (status.selection === null && !status.allowed) {
    return (
      <div className="ix-line"><span className="ix-dot off" aria-hidden />
        <span>Not set up. Choose what the agent can search.</span>
        <button className="btn btn-sm" onClick={() => patch({ rightTab: "files", filesChoose: true, selectedFile: null })}>Choose…</button>
      </div>
    );
  }
  if (status.selection?.off) {
    return (
      <div className="ix-line"><span className="ix-dot off" aria-hidden />
        <span>Search is off for this folder. The agent uses grep and reads files directly.</span>
        <button className="btn btn-sm" onClick={() => chooseSearch({})}>Turn on</button>
      </div>
    );
  }
  const chunks = status.chunks ?? 0;
  const embedded = status.embedded ?? 0;
  const busy = status.building || Boolean(status.embedding) || status.graph_building;
  const meaningReady = status.embed_downloaded && embedded >= chunks;
  const skipped = skippedTotal(status) + Object.values(status.skipped_folders ?? {}).reduce((a, b) => a + b, 0);
  const recent = [...(status.recent ?? [])].reverse();
  return (
    <div className="ix">
      <div className="ix-line">
        <span className={`ix-dot ${busy ? "busy" : ""}`} aria-hidden />
        <span>{busy ? "Updating" : "Up to date"} · {count(chunks, { one: "chunk", many: "chunks" })} from {count(status.files ?? 0, { one: "file", many: "files" })}
          <span className="muted"> · {ago(status.last_sync)}</span></span>
        {!busy && <button className="btn-text ix-act" onClick={() => reindex(false)}>Update now</button>}
      </div>
      <ol className="lanes" aria-label="How the index is built">
        <Lane name="Files" value={(status.files ?? 0).toLocaleString()} sub={skipped ? `${skipped.toLocaleString()} left out` : undefined} />
        <Lane name="Chunks" value={chunks.toLocaleString()} busy={status.building} />
        <Lane name="Vectors" busy={Boolean(status.embedding)} warn={!status.embed_downloaded && !status.embedding}
          value={status.embedding ? `${status.embedding.done.toLocaleString()} of ${status.embedding.total.toLocaleString()}` : status.embed_downloaded ? `${embedded.toLocaleString()}` : "—"}
          sub={status.embedding ? "embedding" : !status.embed_downloaded ? "model not downloaded" : meaningReady ? undefined : `${(chunks - embedded).toLocaleString()} to go`} />
        <Lane name="Map" value={`${(status.entities ?? 0).toLocaleString()}`} sub={`names · ${(status.edges ?? 0).toLocaleString()} links`} busy={status.graph_building} />
      </ol>
      {recent.length > 0 && (
        <ul className="ix-recent" aria-label="Last updates">
          {recent.slice(0, 3).map((r) => <li key={`${r.trigger}-${r.at}`}>{runLine(r)}</li>)}
        </ul>
      )}
      <button className="btn-text ix-more" onClick={() => setDetails(!details)} aria-expanded={details}>
        <Icon name={details ? "chevron-down" : "chevron-right"} size={11} /> Details: what's left out, search by meaning, concepts
      </button>
      {details && (
        <div className="ix-details">
          <div className="ix-block">
            <h4>What's searched</h4>
            {skipped > 0 ? (
              <p className="k-help">{skipped.toLocaleString()} left out: {[...Object.entries(status.skipped ?? {}).map(([r, n]) => `${n.toLocaleString()} ${SKIP_SHORT[r] ?? r}`),
                ...Object.entries(status.skipped_folders ?? {}).map(([r, n]) => `${count(n, { one: "folder", many: "folders" })} (${SKIP_SHORT[r] ?? r})`)].join(", ")}.</p>
            ) : <p className="k-help">Every text file in the folder.</p>}
            {status.capped && <p className="k-help"><strong>Stopped at {(status.max_files ?? 20000).toLocaleString()} files: the rest isn't searched.</strong></p>}
            <div className="k-actions">
              <button className="btn btn-sm" onClick={() => patch({ rightTab: "files", filesChoose: true, selectedFile: null })}>Change what's searched</button>
              {skipped > 0 && <button className="btn-text" onClick={() => patch({ rightTab: "files", filesShow: "out", selectedFile: null })}>See left-out files</button>}
            </div>
          </div>
          <div className="ix-block">
            <h4>{WORDS.meaning.label}</h4>
            <p className="k-help">{WORDS.meaning.means}</p>
            <MeaningSetup status={status} />
          </div>
          <div className="ix-block">
            <h4>{WORDS.concepts.label} <span className="muted">· optional, paid</span></h4>
            <p className="k-help">{WORDS.concepts.means}</p>
            <ConceptsSetup />
          </div>
          {status.location && <p className="k-help muted">The index is kept at <code>{status.location}</code>, outside the project.</p>}
        </div>
      )}
    </div>
  );
}
