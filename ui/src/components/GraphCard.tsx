import { useMemo, useState } from "react";
import type { GraphEdge, GraphNode, GraphResult } from "../protocol";
import { WORDS, count, relation } from "../lib/knowledgeWords";
import { useStore } from "../store";
import { Icon } from "./Icon";

const DIRECT_SHOWN = 6; // rows per relation before "Show N more"
const FAR_SHOWN = 8; // names per distance before "Show N more"

/** A name short enough for a row: a file's own name, or the last part of a dotted code name. */
export function shortName(name: string, max = 40, kind?: string): string {
  const file = kind === "document" || name.includes("/");
  const last = file ? name.slice(name.lastIndexOf("/") + 1) : name.includes(".") && !name.includes(" ") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return last.length > max ? last.slice(0, max - 1) + "…" : last;
}

export function kindClass(kind: string) {
  return ["module", "class", "function", "section", "document", "concept", "component", "symbol"].includes(kind) ? `kind-${kind}` : "kind-other";
}

const inferred = (e: GraphEdge) => e.extractor.startsWith("llm");

type Row = { edge: GraphEdge; node: GraphNode };
type Group = { label: string; rows: Row[] };

/** The neighbourhood as lists, not a picture: what uses the centre (←), what it uses (→), each grouped by relation, then the
 *  names further away, grouped by distance and saying which direct neighbour leads to them. */
export function arrange(graph: GraphResult, showInferred: boolean) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const c = graph.center.id;
  const edges = graph.edges.filter((e) => showInferred || !inferred(e));
  const incoming = new Map<string, Row[]>(), outgoing = new Map<string, Row[]>();
  const via = new Map<number, string>(); // a name 2+ steps away -> the direct neighbour it is reached through
  for (const e of edges) {
    if (e.dst === c && byId.has(e.src)) incoming.set(e.relation, [...(incoming.get(e.relation) ?? []), { edge: e, node: byId.get(e.src)! }]);
    else if (e.src === c && byId.has(e.dst)) outgoing.set(e.relation, [...(outgoing.get(e.relation) ?? []), { edge: e, node: byId.get(e.dst)! }]);
  }
  for (const e of edges) {
    const a = byId.get(e.src), b = byId.get(e.dst);
    if (!a || !b) continue;
    for (const [near, far] of [[a, b], [b, a]] as const) {
      if (far.hop > near.hop && far.hop >= 2 && !via.has(far.id)) via.set(far.id, near.hop === 1 ? near.name : via.get(near.id) ?? near.name);
    }
  }
  const sortGroups = (m: Map<string, Row[]>, out: boolean): Group[] =>
    [...m.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0])).map(([r, rows]) => ({ label: relation(r, out), rows }));
  const far = new Map<number, GraphNode[]>();
  const reachable = new Set(edges.flatMap((e) => [e.src, e.dst]));
  for (const n of graph.nodes) if (n.hop >= 2 && reachable.has(n.id)) far.set(n.hop, [...(far.get(n.hop) ?? []), n]);
  return { incoming: sortGroups(incoming, false), outgoing: sortGroups(outgoing, true), far: [...far.entries()].sort((x, y) => x[0] - y[0]), via };
}

function Cite({ path, start, end, home }: { path: string; start: number; end: number; home?: string }) {
  const patch = useStore((s) => s.patch);
  const file = path === home ? "lines " : path.slice(path.lastIndexOf("/") + 1) + ":"; // the centre's own file goes without saying
  return (
    <button className="g-cite" onClick={() => patch({ rightTab: "files", rightOpen: true, selectedFile: path, selectedRange: { start, end } })}
      title={`Open ${path}:${start}–${end} in Files`}>
      {file}{start}–{end}
    </button>
  );
}

function NameButton({ node, onPick }: { node: GraphNode; onPick?: (name: string) => void }) {
  const label = shortName(node.name, 200, node.kind); // whole: names that share a long start must still differ
  return onPick
    ? <button className="g-target" onClick={() => onPick(node.name)} title={`${node.name} (${node.kind}): see its connections`}>{label}</button>
    : <span className="g-target" title={`${node.name} (${node.kind})`}>{label}</span>;
}

function Side({ title, arrow, groups, onPick, home }: { title: string; arrow: string; groups: Group[]; onPick?: (name: string) => void; home?: string }) {
  const [more, setMore] = useState<Set<string>>(new Set());
  if (!groups.length) return null;
  const total = groups.reduce((a, g) => a + g.rows.length, 0);
  return (
    <section className="g-side" aria-label={title}>
      <h4><span aria-hidden className="g-arrow">{arrow}</span>{title} <span className="muted">{total.toLocaleString()}</span></h4>
      {groups.map((g) => {
        const open = more.has(g.label);
        const rows = open ? g.rows : g.rows.slice(0, DIRECT_SHOWN);
        return (
          <div key={g.label} className="graph-group">
            <h5>{g.label} <span className="muted">{g.rows.length}</span></h5>
            <ul>
              {rows.map(({ edge, node }, i) => (
                <li key={i} className={`graph-link ${inferred(edge) ? "inferred" : ""}`}>
                  <span className={`kind-dot ${kindClass(node.kind)}`} aria-hidden />
                  <NameButton node={node} onPick={onPick} />
                  <span className="g-meta">
                    <span className="g-kind">{node.kind}</span>
                    {inferred(edge) && <span className="chip warn" title={WORDS.inferred.means}>{WORDS.inferred.label}</span>}
                    <Cite path={edge.path} start={edge.start_line} end={edge.end_line} home={home} />
                  </span>
                </li>
              ))}
            </ul>
            {g.rows.length > DIRECT_SHOWN && (
              <button className="btn-text g-more" onClick={() => setMore((s) => { const n = new Set(s); if (open) n.delete(g.label); else n.add(g.label); return n; })}>
                {open ? "Show fewer" : `Show ${(g.rows.length - DIRECT_SHOWN).toLocaleString()} more`}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function Far({ hop, nodes, via, onPick }: { hop: number; nodes: GraphNode[]; via: Map<number, string>; onPick?: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const shown = all ? nodes : nodes.slice(0, FAR_SHOWN);
  return (
    <div className="g-far">
      <button className="g-far-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        {hop} steps away <span className="muted">{count(nodes.length, WORDS.name)}</span>
      </button>
      {open && (
        <ul>
          {shown.map((n) => (
            <li key={n.id} className="graph-link">
              <span className={`kind-dot ${kindClass(n.kind)}`} aria-hidden />
              <NameButton node={n} onPick={onPick} />
              <span className="g-meta">
                <span className="g-kind">{n.kind}</span>
                {via.get(n.id) && <span className="g-via" title={`Reached through ${via.get(n.id)}`}>via {shortName(via.get(n.id)!)}</span>}
              </span>
            </li>
          ))}
          {nodes.length > FAR_SHOWN && !all && <li><button className="btn-text g-more" onClick={() => setAll(true)}>Show {(nodes.length - FAR_SHOWN).toLocaleString()} more</button></li>}
        </ul>
      )}
    </div>
  );
}

/** One name in the project's map and what it connects to, as lists: what uses it, what it uses, and what lies further away.
 *  Every connection cites the snippet it came from (opens in Files). `onPick` looks up another name. */
export function GraphCard({ graph, onPick }: { graph: GraphResult; onPick?: (name: string) => void; inTool?: boolean }) {
  const anyInferred = useMemo(() => graph.edges.some(inferred), [graph]);
  const [showInferred, setShowInferred] = useState(true);
  const { incoming, outgoing, far, via } = useMemo(() => arrange(graph, showInferred), [graph, showInferred]);
  const c = graph.center;
  const direct = graph.nodes.filter((n) => n.hop === 1).length;
  const first = graph.mentioned_in[0];
  return (
    <div className="graph-card">
      <div className="graph-head">
        <span className={`kind-dot ${kindClass(c.kind)}`} aria-hidden />
        <span className="graph-name">{shortName(c.name, 200, c.kind)}</span>
        <span className="chip">{c.kind}</span>
      </div>
      {(shortName(c.name, 200, c.kind) !== c.name || first) && (
        <p className="graph-qual">
          {shortName(c.name, 200, c.kind) !== c.name && <span className="graph-full">{c.name}</span>}
          {first && <Cite path={first.path} start={first.start_line} end={first.end_line} />}
        </p>
      )}
      <p className="graph-summary muted">
        {graph.edges.length === 0 ? "No connections recorded for this one." : `${count(direct, { one: "direct connection", many: "direct connections" })}`
          + (graph.nodes.length - 1 > direct ? ` · ${count(graph.nodes.length - 1 - direct, WORDS.name)} further away` : "")}
        {anyInferred && (
          <label className="g-toggle">
            <input type="checkbox" checked={showInferred} onChange={(e) => setShowInferred(e.target.checked)} />
            Show {WORDS.inferred.label}
          </label>
        )}
      </p>
      <div className="graph-groups">
        <Side title="Uses it" arrow="←" groups={incoming} onPick={onPick} home={first?.path} />
        <Side title="It uses" arrow="→" groups={outgoing} onPick={onPick} home={first?.path} />
        {far.map(([hop, nodes]) => <Far key={hop} hop={hop} nodes={nodes} via={via} onPick={onPick} />)}
      </div>
      {graph.truncated && (
        <p className="muted graph-note">
          Stopped at {count(graph.nodes.length, WORDS.name)}: there are more. Look up one of these, or fewer steps, to see the rest.
        </p>
      )}
      {graph.alternatives.length > 0 && (
        <div className="graph-found">
          <span className="muted">Did you mean</span>
          {graph.alternatives.map((n) => onPick
            ? <button key={n.id} className="btn-text" onClick={() => onPick(n.name)}>{n.name}</button>
            : <span key={n.id} className="g-alt">{n.name}</span>)}
        </div>
      )}
    </div>
  );
}
