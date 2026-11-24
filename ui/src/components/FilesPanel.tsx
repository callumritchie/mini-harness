import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { SKIP_TEXT, WORDS, count, searchable } from "../lib/knowledgeWords";
import { languageFor } from "../lib/lang";
import type { FileChunks, IndexFile, TreeNode } from "../protocol";
import { type Choice, countTicked, fromSelection, ticked, toRequest, toggle as toggleChoice } from "../lib/choose";
import { useStore } from "../store";
import { CodeLine } from "./Code";
import { Icon, type IconName } from "./Icon";
import { PathLabel } from "./PathLabel";

type Changes = ReturnType<typeof useStore.getState>["changes"];

type Show = "all" | "in" | "out";

/** Keep files whose path contains the query (and, unless `show` is "all", that the agent can or can't search), and the folders
 *  that lead to them. */
export function filterTree(nodes: TreeNode[], q: string, show: Show = "all"): TreeNode[] {
  const needle = q.trim().toLowerCase();
  if (!needle && show === "all") return nodes;
  return nodes.flatMap((n) => {
    if (n.type === "dir") {
      if (needle && show === "all" && n.name.toLowerCase().includes(needle)) return [n];
      const kids = filterTree(n.children ?? [], needle, show);
      return kids.length ? [{ ...n, children: kids }] : [];
    }
    const kept = show === "all" || (show === "in") === searchable(n.idx);
    return kept && n.path.toLowerCase().includes(needle) ? [n] : [];
  });
}

/** How many files under a folder the agent can search, of how many (null when the tree has no index marks). */
export function coverage(node: TreeNode): { in: number; all: number } | null {
  if (node.type === "file") return node.idx === undefined ? null : { in: searchable(node.idx) ? 1 : 0, all: 1 };
  let found = false;
  const sum = { in: 0, all: 0 };
  for (const c of node.children ?? []) {
    const n = coverage(c);
    if (n) {
      found = true;
      sum.in += n.in;
      sum.all += n.all;
    }
  }
  return found ? sum : null;
}

type Choosing = { choice: Choice; set: (c: Choice) => void; giAbove: boolean; blocked: boolean };

/** A row with a box to tick, while choosing what the agent may search. */
function ChooseRow({ node, depth, open, toggle, choosing }: { node: TreeNode; depth: number; open: Set<string>; toggle: (p: string) => void; choosing: Choosing }) {
  const on = !choosing.blocked && !node.secret && ticked(node, choosing.choice, choosing.giAbove); // a secret file is never searched
  const sub = node.type === "dir" ? countTicked(node.children ?? [], choosing.choice, choosing.giAbove || Boolean(node.gi)) : null;
  const some = sub !== null && on && sub.on > 0 && sub.on < sub.all;
  const id = `ch-${node.path}`;
  return (
    <div className={`node choose ${node.type} ${on ? "" : "unsearchable"}`} style={{ paddingLeft: 6 + depth * 10 + (node.type === "file" ? 16 : 0) }}>
      {node.type === "dir" && (
        <button className="btn-icon tchev-btn" onClick={() => toggle(node.path)} aria-expanded={open.has(node.path)} aria-label={`${open.has(node.path) ? "Close" : "Open"} ${node.name}`}>
          <Icon name={open.has(node.path) ? "chevron-down" : "chevron-right"} size={10} strokeWidth={1.8} />
        </button>
      )}
      <input id={id} type="checkbox" checked={on} disabled={choosing.blocked || Boolean(node.secret)}
        ref={(el) => { if (el) el.indeterminate = some; }}
        onChange={() => choosing.set(toggleChoice(node, choosing.choice, choosing.giAbove))} />
      <label htmlFor={id} className="nname">{node.name}</label>
      {sub && <span className="ch-count">{sub.on === sub.all || !on ? sub.all.toLocaleString() : `${sub.on.toLocaleString()} of ${sub.all.toLocaleString()}`}</span>}
      {node.gi && !choosing.giAbove && <span className="chip ch-gi" title="Listed in the project's .gitignore: left out unless you tick it">.gitignore</span>}
      {node.secret && <Icon name="lock" size={12} className="lock" />}
    </div>
  );
}

function Node({ node, depth, open, toggle, select, selected, changes, filtering, choosing }: {
  node: TreeNode; depth: number; open: Set<string>; toggle: (p: string) => void; select: (p: string) => void; selected: string | null; changes: Changes; filtering: boolean;
  choosing?: Choosing;
}) {
  const pad = { paddingLeft: 6 + depth * 10 };
  if (choosing) {
    const isOpen = filtering || open.has(node.path);
    const giAbove = choosing.giAbove || Boolean(node.gi);
    const blocked = choosing.blocked || !ticked(node, choosing.choice, choosing.giAbove);
    return (
      <>
        <ChooseRow node={node} depth={depth} open={open} toggle={toggle} choosing={choosing} />
        {node.type === "dir" && isOpen && node.children?.map((c) => (
          <Node key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} select={select} selected={selected} changes={changes} filtering={filtering}
            choosing={{ ...choosing, giAbove, blocked }} />
        ))}
      </>
    );
  }
  if (node.type === "dir") {
    const isOpen = filtering || open.has(node.path);
    const cov = coverage(node);
    const none = cov !== null && cov.all > 0 && cov.in === 0;
    return (
      <>
        <button className={`node dir ${none ? "unsearchable" : ""}`} style={pad} onClick={() => toggle(node.path)} aria-expanded={isOpen}
          title={cov ? `${node.path}: ${cov.in.toLocaleString()} of ${cov.all.toLocaleString()} files searchable by the agent` : node.path}>
          <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={10} strokeWidth={1.8} className="tchev" />
          <span className="nname">{node.name}</span>
          {none && <Icon name="no-search" size={12} className="nosearch" />}
        </button>
        {isOpen && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} select={select} selected={selected} changes={changes} filtering={filtering} />)}
      </>
    );
  }
  const change = changes[node.path];
  const filePad = { paddingLeft: 6 + depth * 10 + 16 }; // lines names up with folder names, which carry a chevron
  const out = !node.secret && !searchable(node.idx);
  const why = node.idx && node.idx !== "in" ? SKIP_TEXT[node.idx] : null;
  return (
    <button className={`node file ${selected === node.path ? "is-selected" : ""} ${out ? "unsearchable" : ""}`} style={filePad}
      onClick={() => !node.secret && select(node.path)} disabled={node.secret}
      aria-label={node.secret ? `${node.name}, Locked` : out ? `${node.name}, not searchable` : undefined}
      title={node.secret ? "Looks like it holds secrets: never shown or searched" : why ? `${node.path}\nNot searchable: ${why}` : node.path}>
      <span className="nname">{node.name}</span>
      {change && <span className={`mark ${change.before === null ? "new" : "mod"}`}>{change.before === null ? "NEW" : "M"}</span>}
      {out && <Icon name="no-search" size={12} className="nosearch" />}
      {node.secret && <Icon name="lock" size={12} className="lock" />}
    </button>
  );
}

/** One line under the viewer's path: whether the agent can search this file, what the index made of it, and where to go next. */
function IndexLine({ path, onCut }: { path: string; onCut?: () => void }) {
  const [info, setInfo] = useState<IndexFile | null>(null);
  const patch = useStore((s) => s.patch);
  const synced = useStore((s) => s.indexStatus?.last_sync);
  useEffect(() => {
    let live = true;
    api<IndexFile>("index/file", { path }).then((r) => live && setInfo(r)).catch(() => live && setInfo(null));
    return () => { live = false; };
  }, [path, synced]);
  if (!info || info.state === "unavailable") return null;
  if (info.state !== "in") {
    return (
      <p className="index-line out">
        <Icon name="no-search" size={12} />
        <span>Not in the agent's search: {SKIP_TEXT[info.state].replace(/^./, (c) => c.toLowerCase())}</span>
      </p>
    );
  }
  return (
    <p className="index-line">
      <span title={WORDS.snippet.means}>Searchable · {onCut ? <button className="btn-text ci-link" onClick={onCut}>{count(info.snippets ?? 0, WORDS.snippet)}</button> : count(info.snippets ?? 0, WORDS.snippet)}</span>
      {(info.connections ?? 0) > 0 && <span title={WORDS.connection.means}>· {count(info.connections ?? 0, WORDS.connection)}</span>}
      <span className="index-actions">
        <button className="btn-text" onClick={() => patch({ rightTab: "knowledge", knowledgeSearch: { query: "", pathPrefix: path } })}>Search in this file</button>
        {info.entity && <button className="btn-text" onClick={() => patch({ rightTab: "knowledge", knowledgeQuery: info.entity! })}>See connections</button>}
      </span>
    </p>
  );
}

/** How the index cut this file, for the viewer's gutter. Null until loaded, or when the file isn't in the index. */
function useChunks(path: string) {
  const [cut, setCut] = useState<FileChunks | null>(null);
  const synced = useStore((s) => s.indexStatus?.last_sync);
  useEffect(() => {
    let live = true;
    api<FileChunks>("index/chunks", { path }).then((r) => live && setCut(r.chunks.length ? r : null)).catch(() => live && setCut(null));
    return () => { live = false; };
  }, [path, synced]);
  return cut;
}

const RULE = {
  code: (c: FileChunks) => `Code is cut into windows of ${c.size} lines, each sharing ${c.overlap} with the next, so something that straddles a cut is whole in one of them.`,
  prose: (c: FileChunks) => `Text is cut into windows of ${c.size} lines, each sharing ${c.overlap} with the next.`,
  markdown: (c: FileChunks) => `Markdown is cut where its headings start; small sections are packed together up to ${c.size} lines, and a long one is cut into windows inside itself.`,
};

/** The chunk picked in the gutter (or how the file is cut, before one is picked). */
function ChunkInfo({ cut, at, onPick, onClose }: { cut: FileChunks; at: number | null; onPick: (i: number) => void; onClose: () => void }) {
  const patch = useStore((s) => s.patch);
  const c = at === null ? null : cut.chunks[at];
  const prev = at ? cut.chunks[at - 1] : null;
  const shared = c && prev && prev.end >= c.start ? `${c.start}–${prev.end}` : null;
  return (
    <div className="chunk-info" role="region" aria-label={c ? `Chunk ${at! + 1}` : "How this file is cut"}>
      <div className="ci-head">
        <strong>{c ? `Chunk ${at! + 1} of ${cut.chunks.length} · lines ${c.start}–${c.end}` : `${count(cut.chunks.length, { one: "chunk", many: "chunks" })}`}</strong>
        <span className="ci-nav">
          <button className="btn btn-xs" onClick={() => onPick(at === null ? 0 : Math.max(0, at - 1))} disabled={at === 0} aria-label="Previous chunk">‹</button>
          <button className="btn btn-xs" onClick={() => onPick(at === null ? 0 : Math.min(cut.chunks.length - 1, at + 1))} disabled={at === cut.chunks.length - 1} aria-label="Next chunk">›</button>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><Icon name="close" size={12} /></button>
        </span>
      </div>
      {c ? (
        <>
          {c.heading && <span className="muted">§ {c.heading}</span>}
          {shared && <span className="muted">Shares lines {shared} with chunk {at}</span>}
          <span>{c.embedded === null ? "Search by meaning isn't ready yet" : c.embedded ? "Findable by meaning and by keyword" : "Findable by keyword; by meaning once it's embedded"}</span>
          {c.names.length > 0 && (
            <span className="ci-names">On the map: {c.names.slice(0, 8).map((n) => (
              <button key={n} className="g-cite" onClick={() => patch({ rightTab: "knowledge", knowledgeQuery: n })}>{n.split(".").pop()}</button>
            ))}{c.names.length > 8 && <span className="muted"> +{c.names.length - 8}</span>}</span>
          )}
        </>
      ) : <span className="muted">{RULE[cut.kind](cut)} Click a stripe beside the line numbers to see one chunk.</span>}
    </div>
  );
}

function Cant({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <div className="cant">
      <span className="cant-tile"><Icon name={icon} /></span>
      <div><div className="cant-title">{title}</div><div className="cant-body">{children}</div></div>
    </div>
  );
}

function Viewer({ path, onBack }: { path: string; onBack: () => void }) {
  const [state, setState] = useState<{ content?: string; binary?: boolean; truncated?: boolean; error?: string }>({});
  const changed = useStore((s) => Boolean(s.changes[path]));
  const wrap = useStore((s) => s.wrap);
  const toggleWrap = useStore((s) => s.toggleWrap);
  const patch = useStore((s) => s.patch);
  const range = useStore((s) => s.selectedRange); // a search_docs passage: these lines are marked and scrolled to
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setState({});
    api<{ content: string; binary: boolean; truncated: boolean }>("file", { path })
      .then((r) => live && setState(r))
      .catch((e: Error) => live && setState({ error: e.message }));
    return () => { live = false; };
  }, [path]);
  useEffect(() => {
    first.current?.scrollIntoView?.({ block: "center" });
  }, [state.content, range]);
  const lang = languageFor(path);
  const lines = state.content?.split("\n") ?? [];
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const marked = (n: number) => range !== null && n >= range.start && n <= range.end;
  const cut = useChunks(path);
  const [picked, setPicked] = useState<number | null>(null);
  const [info, setInfo] = useState(false);
  useEffect(() => { setPicked(null); setInfo(false); }, [path]);
  const stripes = useMemo(() => { // per line: the chunk on stripe A (even chunks) and on stripe B (odd), or -1
    if (!cut) return null;
    const a = new Int32Array(lines.length + 2).fill(-1), b = new Int32Array(lines.length + 2).fill(-1);
    cut.chunks.forEach((c, i) => { for (let n = c.start; n <= Math.min(c.end, lines.length); n++) (i % 2 ? b : a)[n] = i; });
    return { a, b };
  }, [cut, lines.length]);
  const pick = (i: number) => { // mark the chunk's lines and bring them into view, as a search result does
    setPicked(i);
    setInfo(true);
    if (cut) patch({ selectedRange: { start: cut.chunks[i].start, end: cut.chunks[i].end } });
  };
  return (
    <div className="viewer">
      <div className="viewer-head">
        <button className="btn-icon back" onClick={onBack} aria-label="Back to files" title="Back to files"><Icon name="back" /></button>
        <PathLabel path={path} className="path" />
        {state.content !== undefined && <span className="vmeta">{lines.length.toLocaleString()} line{lines.length === 1 ? "" : "s"}</span>}
        {state.content !== undefined && <button className="btn btn-xs" onClick={toggleWrap} aria-pressed={wrap} title="Wrap long lines">Wrap</button>}
        {changed && <button className="btn btn-sm" onClick={() => patch({ rightTab: "changes", selectedChange: path })}>See changes</button>}
      </div>
      <IndexLine path={path} onCut={cut ? () => { setPicked(null); setInfo(!info); } : undefined} />
      {cut && info && <ChunkInfo cut={cut} at={picked} onPick={pick} onClose={() => { setInfo(false); setPicked(null); }} />}
      {state.error && <div className="cant-wrap"><Cant icon="alert-circle" title={path}>{state.error}</Cant></div>}
      {state.binary && <div className="cant-wrap"><Cant icon="file" title={path}>Binary file: there's no text to show.</Cant></div>}
      {state.content !== undefined && (
        <div className={`code ${wrap ? "wrap" : "nowrap"} ${stripes ? "has-cg" : ""}`}>
          {lines.map((l, i) => (
            <div key={i} ref={range?.start === i + 1 ? first : undefined} className={`row ${marked(i + 1) ? "marked" : ""}`}>
              {stripes && (
                <span className="cg" aria-hidden>
                  {[stripes.a[i + 1], stripes.b[i + 1]].map((c, k) => (
                    <span key={k} className={`cg-s ${c >= 0 ? `on s${k}` : ""} ${c >= 0 && c === picked ? "picked" : ""}`} onClick={c >= 0 ? () => pick(c) : undefined}
                      title={c >= 0 ? `Chunk ${c + 1}: lines ${cut!.chunks[c].start}–${cut!.chunks[c].end}` : undefined} />
                  ))}
                </span>
              )}
              <span className="no">{i + 1}</span><code><CodeLine text={l} lang={lang} /></code>
            </div>
          ))}
        </div>
      )}
      {state.truncated && <div className="cant-wrap"><Cant icon="file" title="The rest is not shown">The file was cut after 400 KB. Open it in your editor for the rest.</Cant></div>}
    </div>
  );
}

export function FilesPanel() {
  const running = useStore((s) => s.running);
  const selected = useStore((s) => s.selectedFile);
  const patch = useStore((s) => s.patch);
  const changes = useStore((s) => s.changes);
  const show = useStore((s) => s.filesShow);
  const synced = useStore((s) => s.indexStatus?.last_sync);
  const choosingOn = useStore((s) => s.filesChoose);
  const selection = useStore((s) => s.indexStatus?.selection);
  const chooseSearch = useStore((s) => s.chooseSearch);
  const [choice, setChoice] = useState<Choice | null>(null);
  useEffect(() => { setChoice(choosingOn ? fromSelection(selection) : null); }, [choosingOn]); // eslint-disable-line react-hooks/exhaustive-deps
  const [filter, setFilter] = useState("");
  const [tree, setTree] = useState<{ name: string; tree: TreeNode[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    api<{ name: string; tree: TreeNode[] }>("files").then(setTree).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load, running, synced]); // a task may have created files; an index update changes what is searchable

  if (selected && !choosingOn) return <Viewer path={selected} onBack={() => patch({ selectedFile: null, selectedRange: null })} />;
  if (error) return <div className="cant-wrap"><Cant icon="alert-circle" title="Can't list the files">{error}</Cant></div>;
  if (!tree) return <div className="empty-panel">Loading…</div>;
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const shown = filterTree(tree.tree, filter, choice ? "all" : show);
  const marked = !choice && tree.tree.some((n) => coverage(n) !== null);
  const total = choice ? countTicked(tree.tree, choice) : null;
  const save = () => {
    if (!choice) return;
    chooseSearch(toRequest(choice));
    patch({ filesChoose: false });
  };
  return (
    <div className="tree">
      {choice && total && (
        <div className="choose-bar" role="region" aria-label="Choose what the agent can search">
          <div className="choose-text">
            <strong>Choose what the agent can search</strong>
            <span className="muted">Untick folders, or single files, to leave them out. Folders in .gitignore start unticked.</span>
          </div>
          <div className="choose-actions">
            <button className="btn btn-sm" onClick={() => patch({ filesChoose: false })}>Cancel</button>
            <button className="btn btn-sm btn-primary" onClick={save} disabled={total.on === 0}>Search {count(total.on, { one: "file", many: "files" })}</button>
          </div>
        </div>
      )}
      <div className="filterbox">
        <input className="field" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" aria-label="Filter files" />
        {marked && (
          <select className="field show-select" value={show} onChange={(e) => patch({ filesShow: e.target.value as Show })} aria-label="Which files to list">
            <option value="all">All files</option>
            <option value="in">Searchable</option>
            <option value="out">Not searchable</option>
          </select>
        )}
        <button className="btn-icon" onClick={load} aria-label="Refresh" title="Refresh"><Icon name="retry" /></button>
      </div>
      <div className="tree-rows">
        {tree.tree.length === 0 && <div className="empty-panel">This folder is empty.</div>}
        {tree.tree.length > 0 && shown.length === 0 && (
          <div className="empty-panel">
            {filter.trim() ? `No files match “${filter}”.` : show === "out" ? "The agent can search every file listed here." : "No files the agent can search yet."}
          </div>
        )}
        {shown.map((n) => <Node key={n.path} node={n} depth={0} open={open} toggle={toggle} select={(p) => patch({ selectedFile: p, selectedRange: null })} selected={selected} changes={changes}
          filtering={filter.trim() !== "" || (!choice && show !== "all")} choosing={choice ? { choice, set: setChoice, giAbove: false, blocked: false } : undefined} />)}
      </div>
      {!choice && selection && (
        <button className="btn-text choose-link" onClick={() => patch({ filesChoose: true })}>Change what the agent can search</button>
      )}
      <p className="tree-note">
        Read-only. NEW and M mark files written in this session. Locked files are secrets: shown by name, never opened.
        {marked && <> <Icon name="no-search" size={11} /> Dimmed files aren't in the agent's search (hover one to see why).</>}
      </p>
    </div>
  );
}
