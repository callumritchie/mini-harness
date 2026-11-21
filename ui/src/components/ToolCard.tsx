import { useMemo, useState } from "react";
import { useStore, type Item } from "../store";
import type { ToolItem } from "../lib/group";
import { diffRows, diffStats } from "../lib/diff";
import { Icon } from "./Icon";
import { ToolIcon } from "./ToolIcon";
import { Spinner } from "./Spinner";

const LIMIT = 4000;
const MCP_MARK = "[output from MCP server";

/** The tool call the open approval is about: until the server sends tool ids, the latest one still running. */
function waitingId(items: Item[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.status === "running") return it.id;
  }
  return null;
}

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [copied, setCopied] = useState(false);
  const patch = useStore((s) => s.patch);
  const waiting = useStore((s) => (s.permission ? waitingId(s.items) : null)) === item.id;
  const path = typeof item.input.path === "string" ? item.input.path : null;
  const editsFile = (item.name === "write_file" || item.name === "edit_file") && path;
  const change = useStore((s) => (editsFile && path ? s.changes[path] : undefined));
  const rows = useMemo(() => (change ? diffRows(change.before, change.after) : null), [change]);
  const stats = rows ? diffStats(rows) : null;
  const result = item.result ?? "";
  const shown = more || result.length <= LIMIT ? result : result.slice(0, LIMIT);
  const mcp = result.startsWith(MCP_MARK);
  const command = item.name === "bash" && typeof item.input.command === "string" ? item.input.command : null;
  // the result text is written for the model; the row's summary is written for the person
  const nextStep = item.isError && !item.denied ? result.split("\n").find((l) => l.trim()) ?? "" : "";

  const copy = () => {
    navigator.clipboard?.writeText(result).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  };

  let outcome: React.ReactNode = null;
  if (item.denied) outcome = <span className="chip bad">{item.denied === "judge" ? "judge denied" : "you denied"}</span>;
  else if (waiting) outcome = <span className="chip accent">waiting for you</span>;
  else if (item.status === "running") outcome = <span className="tool-meta">running</span>;
  else if (item.isError) outcome = <span className="tool-meta bad">failed</span>;
  else if (stats) outcome = <span className="tool-outcome"><span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span></span>;

  return (
    <div className={`tool ${item.isError ? "error" : ""} ${item.denied ? "denied" : ""} ${waiting ? "waiting" : ""} ${open ? "open" : ""} ${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-state">
          {waiting ? <span className="wait-dot" role="img" aria-label="waiting for you" />
            : item.status === "running" ? <Spinner label="running" />
            : item.isError ? <span className="st bad" role="img" aria-label="failed">✕</span>
            : <span className="st ok" role="img" aria-label="done">✓</span>}
        </span>
        <ToolIcon name={item.name} />
        <span className="tool-display">{item.display}</span>
        <span className="tool-right">{outcome}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="chev" />
      </button>
      {nextStep && !open && <div className="tool-err">{nextStep}</div>}
      {open && (
        <div className="tool-body">
          {command !== null && <pre className="tool-cmd"><span className="muted">$ </span>{command}</pre>}
          {rows && !item.isError && (
            <div className="tool-diff" role="table" aria-label={`Changes to ${path}`}>
              {rows.map((r, i) =>
                r.type === "gap" ? <div key={i} className="drow gap">⋯ {r.text}</div> : (
                  <div key={i} className={`drow ${r.type}`}>
                    <span className="dno">{r.type === "add" ? r.newNo : r.oldNo ?? r.newNo}</span>
                    <span className="dsign">{r.type === "add" ? "+" : r.type === "del" ? "−" : " "}</span>
                    <code>{r.text || " "}</code>
                  </div>
                ),
              )}
            </div>
          )}
          {item.result !== null && (
            <>
              {mcp && <div className="mcp-banner">{result.split("\n", 1)[0]}</div>}
              <pre className="tool-out">{mcp ? shown.slice(shown.indexOf("\n") + 1) : shown}</pre>
            </>
          )}
          {showInput && <pre className="tool-out input">{JSON.stringify(item.input, null, 2)}</pre>}
          <div className="tool-foot">
            {item.result !== null && <button className="btn btn-sm" onClick={copy}>{copied ? "Copied" : "Copy output"}</button>}
            {editsFile && item.status === "done" && !item.isError && (
              <button className="btn btn-sm" onClick={() => patch({ rightTab: "changes", rightOpen: true, selectedChange: path })}>Open in Changes</button>
            )}
            <button className="btn-text" onClick={() => setShowInput(!showInput)} aria-expanded={showInput}>{showInput ? "Hide input JSON" : "Show input JSON"}</button>
            {!more && result.length > LIMIT && (
              <>
                <span className="spacer" />
                <span className="tool-meta">Showing the first {LIMIT.toLocaleString()} characters</span>
                <button className="btn btn-sm" onClick={() => setMore(true)}>Show the other {(result.length - LIMIT).toLocaleString()}</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
