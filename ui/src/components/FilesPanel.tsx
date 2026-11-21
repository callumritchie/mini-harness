import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { languageFor } from "../lib/lang";
import type { TreeNode } from "../protocol";
import { useStore } from "../store";
import { CodeLine } from "./Code";

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

function Lock() {
  return (
    <svg className="lock" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function Node({ node, depth, open, toggle, select, selected, changes, filtering }: {
  node: TreeNode; depth: number; open: Set<string>; toggle: (p: string) => void; select: (p: string) => void; selected: string | null; changes: Changes; filtering: boolean;
}) {
  const pad = { paddingLeft: 8 + depth * 14 };
  if (node.type === "dir") {
    const isOpen = filtering || open.has(node.path);
    return (
      <>
        <button className="node dir" style={pad} onClick={() => toggle(node.path)}>{isOpen ? "▾" : "▸"} {node.name}</button>
        {isOpen && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} select={select} selected={selected} changes={changes} filtering={filtering} />)}
      </>
    );
  }
  const change = changes[node.path];
  return (
    <button className={`node file ${selected === node.path ? "on" : ""}`} style={pad} onClick={() => !node.secret && select(node.path)}
      disabled={node.secret} aria-label={node.secret ? `${node.name}, Locked` : undefined} title={node.secret ? "Looks like it holds secrets: never shown" : node.path}>
      {node.secret ? <Lock /> : "·"} <span className="nname">{node.name}</span>
      {change && <span className={`mark ${change.before === null ? "new" : "mod"}`}>{change.before === null ? "NEW" : "M"}</span>}
    </button>
  );
}

function Viewer({ path, onBack }: { path: string; onBack: () => void }) {
  const [state, setState] = useState<{ content?: string; binary?: boolean; truncated?: boolean; error?: string }>({});
  useEffect(() => {
    let live = true;
    setState({});
    api<{ content: string; binary: boolean; truncated: boolean }>("file", { path })
      .then((r) => live && setState(r))
      .catch((e: Error) => live && setState({ error: e.message }));
    return () => { live = false; };
  }, [path]);
  const lang = languageFor(path);
  const lines = state.content?.split("\n") ?? [];
  return (
    <div className="viewer">
      <div className="viewer-head">
        <button className="icon back" onClick={onBack} aria-label="Back to files" title="Back to files">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <span className="path">{path}</span>
      </div>
      {state.error && <div className="error-line">{state.error}</div>}
      {state.binary && <div className="empty-panel">Binary file: not shown.</div>}
      {state.content !== undefined && (
        <div className="code">
          {lines.map((l, i) => (
            <div key={i} className="row"><span className="no">{i + 1}</span><code><CodeLine text={l} lang={lang} /></code></div>
          ))}
          {state.truncated && <div className="muted pad">…file cut after 400 KB</div>}
        </div>
      )}
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

  if (selected) return <Viewer path={selected} onBack={() => patch({ selectedFile: null })} />;
  if (error) return <div className="error-line">{error}</div>;
  if (!tree) return <div className="empty-panel">Loading…</div>;
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const shown = filterTree(tree.tree, filter);
  return (
    <div className="tree">
      <div className="tree-head"><span>{tree.name}</span><button className="link" onClick={load}>Refresh</button></div>
      <div className="filterbox"><input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" aria-label="Filter files" /></div>
      {tree.tree.length === 0 && <div className="empty-panel">This folder is empty.</div>}
      {tree.tree.length > 0 && shown.length === 0 && <div className="empty-panel">No files match “{filter}”.</div>}
      {shown.map((n) => <Node key={n.path} node={n} depth={0} open={open} toggle={toggle} select={(p) => patch({ selectedFile: p })} selected={selected} changes={changes} filtering={filter.trim() !== ""} />)}
    </div>
  );
}
