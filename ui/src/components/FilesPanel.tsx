import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { languageFor } from "../lib/lang";
import type { TreeNode } from "../protocol";
import { useStore } from "../store";
import { CodeLine } from "./Code";
import { Icon, type IconName } from "./Icon";

type Changes = ReturnType<typeof useStore.getState>["changes"];

/** Keep files whose path contains the query, and the folders that lead to them. */
export function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((n) => {
    if (n.type === "dir") {
      if (n.name.toLowerCase().includes(needle)) return [n];
      const kids = filterTree(n.children ?? [], needle);
      return kids.length ? [{ ...n, children: kids }] : [];
    }
    return n.path.toLowerCase().includes(needle) ? [n] : [];
  });
}

function Node({ node, depth, open, toggle, select, selected, changes, filtering }: {
  node: TreeNode; depth: number; open: Set<string>; toggle: (p: string) => void; select: (p: string) => void; selected: string | null; changes: Changes; filtering: boolean;
}) {
  const pad = { paddingLeft: 6 + depth * 10 };
  if (node.type === "dir") {
    const isOpen = filtering || open.has(node.path);
    return (
      <>
        <button className="node dir" style={pad} onClick={() => toggle(node.path)} aria-expanded={isOpen}>
          <Icon name={isOpen ? "chevron-down" : "chevron-right"} size={10} strokeWidth={1.8} className="tchev" />
          <span className="nname">{node.name}</span>
        </button>
        {isOpen && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} select={select} selected={selected} changes={changes} filtering={filtering} />)}
      </>
    );
  }
  const change = changes[node.path];
  const filePad = { paddingLeft: 6 + depth * 10 + 16 }; // lines names up with folder names, which carry a chevron
  return (
    <button className={`node file ${selected === node.path ? "is-selected" : ""}`} style={filePad} onClick={() => !node.secret && select(node.path)}
      disabled={node.secret} aria-label={node.secret ? `${node.name}, Locked` : undefined} title={node.secret ? "Looks like it holds secrets: never shown" : node.path}>
      <span className="nname">{node.name}</span>
      {change && <span className={`mark ${change.before === null ? "new" : "mod"}`}>{change.before === null ? "NEW" : "M"}</span>}
      {node.secret && <Icon name="lock" size={12} className="lock" />}
    </button>
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
  return (
    <div className="viewer">
      <div className="viewer-head">
        <button className="btn-icon back" onClick={onBack} aria-label="Back to files" title="Back to files"><Icon name="back" /></button>
        <span className="path">{path}</span>
        {state.content !== undefined && <span className="vmeta">{lines.length.toLocaleString()} line{lines.length === 1 ? "" : "s"}</span>}
        {state.content !== undefined && <button className="btn btn-xs" onClick={toggleWrap} aria-pressed={wrap} title="Wrap long lines">Wrap</button>}
        {changed && <button className="btn btn-sm" onClick={() => patch({ rightTab: "changes", selectedChange: path })}>See changes</button>}
      </div>
      {state.error && <div className="cant-wrap"><Cant icon="alert-circle" title={path}>{state.error}</Cant></div>}
      {state.binary && <div className="cant-wrap"><Cant icon="file" title={path}>Binary file: there's no text to show.</Cant></div>}
      {state.content !== undefined && (
        <div className={`code ${wrap ? "wrap" : "nowrap"}`}>
          {lines.map((l, i) => (
            <div key={i} ref={range?.start === i + 1 ? first : undefined} className={`row ${marked(i + 1) ? "marked" : ""}`}>
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
  const [filter, setFilter] = useState("");
  const [tree, setTree] = useState<{ name: string; tree: TreeNode[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    api<{ name: string; tree: TreeNode[] }>("files").then(setTree).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load, running]); // reload when a task ends: it may have created files

  if (selected) return <Viewer path={selected} onBack={() => patch({ selectedFile: null, selectedRange: null })} />;
  if (error) return <div className="cant-wrap"><Cant icon="alert-circle" title="Can't list the files">{error}</Cant></div>;
  if (!tree) return <div className="empty-panel">Loading…</div>;
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const shown = filterTree(tree.tree, filter);
  return (
    <div className="tree">
      <div className="filterbox">
        <input className="field" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" aria-label="Filter files" />
        <button className="btn-icon" onClick={load} aria-label="Refresh" title="Refresh"><Icon name="retry" /></button>
      </div>
      <div className="tree-rows">
        {tree.tree.length === 0 && <div className="empty-panel">This folder is empty.</div>}
        {tree.tree.length > 0 && shown.length === 0 && <div className="empty-panel">No files match “{filter}”.</div>}
        {shown.map((n) => <Node key={n.path} node={n} depth={0} open={open} toggle={toggle} select={(p) => patch({ selectedFile: p, selectedRange: null })} selected={selected} changes={changes} filtering={filter.trim() !== ""} />)}
      </div>
      <p className="tree-note">Read-only. NEW and M mark files written in this session. Locked files are secrets: shown by name, never opened.</p>
    </div>
  );
}
