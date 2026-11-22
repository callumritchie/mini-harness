import { useMemo } from "react";
import type { GraphEdge, GraphNode, GraphResult } from "../protocol";
import { useStore } from "../store";

const MAX_DRAWN = 40;
const LABELS_UP_TO = 14; // more nodes than this and the picture shows dots; names are in the list and on hover
const W = 360;
const height = (n: number) => (n <= 4 ? 130 : n <= 12 ? 180 : 220); // a few nodes need little room

/** A name short enough for a label: a file's own name, or the last part of a dotted code name. */
export function shortName(name: string, max = 16, kind?: string): string {
  const file = kind === "document" || name.includes("/");
  const last = file ? name.slice(name.lastIndexOf("/") + 1) : name.includes(".") && !name.includes(" ") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return last.length > max ? last.slice(0, max - 1) + "…" : last;
}

/** Where each node sits: the centre in the middle, each hop on its own ring, spread evenly. */
export function layout(nodes: GraphNode[], H = height(Math.min(nodes.length, MAX_DRAWN))): Map<number, { x: number; y: number }> {
  const pos = new Map<number, { x: number; y: number }>();
  const byHop = new Map<number, GraphNode[]>();
  for (const n of nodes.slice(0, MAX_DRAWN)) byHop.set(n.hop, [...(byHop.get(n.hop) ?? []), n]);
  const rings = Math.max(1, ...byHop.keys());
  for (const [hop, ring] of byHop) {
    if (hop === 0) {
      for (const n of ring) pos.set(n.id, { x: W / 2, y: H / 2 });
      continue;
    }
    const rx = ((W / 2 - 34) * hop) / rings, ry = ((H / 2 - 22) * hop) / rings;
    ring.forEach((n, i) => {
      const a = -Math.PI / 2 + (2 * Math.PI * i) / ring.length + (hop % 2 ? 0 : Math.PI / ring.length);
      pos.set(n.id, { x: W / 2 + rx * Math.cos(a), y: H / 2 + ry * Math.sin(a) });
    });
  }
  return pos;
}

function kindClass(kind: string) {
  return ["module", "class", "function", "section", "document", "concept", "component", "symbol"].includes(kind) ? `k-${kind}` : "k-other";
}

/** One thing in the project's knowledge graph and its neighbourhood: a small picture, then every link grouped by kind, each citing
 *  the passage it came from (click to open it in Files). `onPick` looks up another thing (a node or a close match). */
export function GraphCard({ graph, onPick, inTool = false }: { graph: GraphResult; onPick?: (name: string) => void; inTool?: boolean }) {
  const patch = useStore((s) => s.patch);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const H = height(Math.min(graph.nodes.length, MAX_DRAWN));
  const pos = useMemo(() => layout(graph.nodes, H), [graph, H]);
  const groups = useMemo(() => {
    const m = new Map<string, GraphEdge[]>();
    for (const e of graph.edges) m.set(e.relation, [...(m.get(e.relation) ?? []), e]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [graph]);
  const open = (path: string, start: number, end: number) =>
    patch({ rightTab: "files", rightOpen: true, selectedFile: path, selectedRange: { start, end } });
  const c = graph.center;
  const drawn = graph.nodes.slice(0, MAX_DRAWN);
  const labels = drawn.length <= LABELS_UP_TO;
  const pick = (n: GraphNode) => onPick && n.id !== c.id && onPick(n.name);

  const linkText = (e: GraphEdge) => {
    const src = byId.get(e.src)!, dst = byId.get(e.dst)!;
    if (e.src === c.id) return { arrow: "→", node: dst };
    if (e.dst === c.id) return { arrow: "←", node: src };
    return { arrow: "", node: dst, from: src };
  };

  return (
    <div className="graph-card">
      <div className="graph-head">
        <span className={`kind-dot ${kindClass(c.kind)}`} aria-hidden />
        <span className="graph-name" title={c.name}>{c.name}</span>
        <span className="chip">{c.kind}</span>
        {!inTool && <span className="tool-meta">{graph.edges.length} link{graph.edges.length === 1 ? "" : "s"}</span>}
      </div>
      {graph.edges.length > 0 && (
        <svg className="graph-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${c.name} and ${drawn.length - 1} connected things`}>
          {graph.edges.map((e, i) => {
            const a = pos.get(e.src), b = pos.get(e.dst);
            return a && b ? <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`g-edge ${e.extractor.startsWith("llm") ? "llm" : ""}`} /> : null;
          })}
          {drawn.map((n) => {
            const p = pos.get(n.id)!;
            const center = n.id === c.id;
            return (
              <g key={n.id} className={`g-node ${kindClass(n.kind)} ${center ? "center" : ""} ${onPick && !center ? "pickable" : ""}`}
                transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} onClick={() => pick(n)}>
                <title>{`${n.name} (${n.kind})`}</title>
                <circle r={center ? 8 : 5} />
                {(labels || center) && <text y={center ? -12 : -8} textAnchor="middle">{shortName(n.name, 16, n.kind)}</text>}
              </g>
            );
          })}
        </svg>
      )}
      <div className="graph-groups">
        {groups.map(([relation, edges]) => (
          <section key={relation} className="graph-group">
            <h4>{relation} <span className="muted">{edges.length}</span></h4>
            <ul>
              {edges.map((e, i) => {
                const t = linkText(e);
                return (
                  <li key={i} className="graph-link">
                    {t.from ? <span className="g-from" title={t.from.name}>{shortName(t.from.name, 24, t.from.kind)} →</span> : <span className="g-arrow" aria-label={t.arrow === "→" ? "to" : "from"}>{t.arrow}</span>}
                    {onPick ? <button className="g-target" onClick={() => onPick(t.node.name)} title={`Look up ${t.node.name}`}>{t.node.name}</button>
                      : <span className="g-target" title={t.node.name}>{t.node.name}</span>}
                    <span className="g-kind">{t.node.kind}</span>
                    {e.extractor.startsWith("llm") && <span className="chip warn" title="Found by a model reading the prose, not by parsing">model</span>}
                    <button className="g-cite" onClick={() => open(e.path, e.start_line, e.end_line)} title={`Open ${e.path}:${e.start_line}–${e.end_line} in Files`}>
                      {e.path}:{e.start_line}–{e.end_line}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {graph.edges.length === 0 && <p className="muted graph-empty">No links recorded for this one.</p>}
      </div>
      {graph.mentioned_in.length > 0 && (
        <div className="graph-found">
          <span className="muted">Found in</span>
          {graph.mentioned_in.map((m) => (
            <button key={m.chunk_id} className="g-cite" onClick={() => open(m.path, m.start_line, m.end_line)}>{m.path}:{m.start_line}–{m.end_line}</button>
          ))}
        </div>
      )}
      {graph.truncated && <p className="muted graph-note">Stopped at {graph.nodes.length} things: look up something narrower to see the rest.</p>}
      {graph.alternatives.length > 0 && (
        <div className="graph-found">
          <span className="muted">Also matches</span>
          {graph.alternatives.map((n) => onPick
            ? <button key={n.id} className="btn-text" onClick={() => onPick(n.name)}>{n.name}</button>
            : <span key={n.id} className="g-alt">{n.name}</span>)}
        </div>
      )}
    </div>
  );
}
