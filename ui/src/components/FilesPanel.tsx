import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { languageFor } from "../lib/lang";
import type { TreeNode } from "../protocol";
import { useStore } from "../store";
import { CodeLine } from "./Code";

function Node({ node, depth, open, toggle, select, selected }: {
  node: TreeNode; depth: number; open: Set<string>; toggle: (p: string) => void; select: (p: string) => void; selected: string | null;
}) {
  const pad = { paddingLeft: 8 + depth * 14 };
  if (node.type === "dir") {
    const isOpen = open.has(node.path);
    return (
      <>
        <button className="node dir" style={pad} onClick={() => toggle(node.path)}>{isOpen ? "▾" : "▸"} {node.name}</button>
        {isOpen && node.children?.map((c) => <Node key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} select={select} selected={selected} />)}
      </>
    );
  }
  return (
    <button className={`node file ${selected === node.path ? "on" : ""}`} style={pad} onClick={() => !node.secret && select(node.path)}
      disabled={node.secret} title={node.secret ? "Looks like it holds secrets: never shown" : node.path}>
      {node.secret ? "🔒" : "·"} {node.name}
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
      <div className="viewer-head"><button className="link" onClick={onBack}>← Files</button><span className="path">{path}</span></div>
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
  return (
    <div className="tree">
      <div className="tree-head"><span>{tree.name}</span><button className="link" onClick={load}>Refresh</button></div>
      {tree.tree.length === 0 && <div className="empty-panel">This folder is empty.</div>}
      {tree.tree.map((n) => <Node key={n.path} node={n} depth={0} open={open} toggle={toggle} select={(p) => patch({ selectedFile: p })} selected={selected} />)}
    </div>
  );
}
