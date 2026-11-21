import { useMemo, useState } from "react";
import { useStore } from "../store";
import type { ToolItem } from "../lib/group";
import { diffRows, diffStats } from "../lib/diff";
import { ToolIcon } from "./ToolIcon";
import { Spinner } from "./Spinner";

const LIMIT = 4000;

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [copied, setCopied] = useState(false);
  const patch = useStore((s) => s.patch);
  const path = typeof item.input.path === "string" ? item.input.path : null;
  const editsFile = (item.name === "write_file" || item.name === "edit_file") && path;
  const change = useStore((s) => (editsFile && path ? s.changes[path] : undefined));
  const stats = useMemo(() => (change ? diffStats(diffRows(change.before, change.after)) : null), [change]);
  const result = item.result ?? "";
  const shown = more || result.length <= LIMIT ? result : result.slice(0, LIMIT);
  // the result text is written for the model; the row's summary is written for the person
  const denied = item.denied ? (item.denied === "judge" ? "The judge denied this." : "You denied this.") : "";
  const firstError = denied || (item.isError ? result.split("\n").find((l) => l.trim()) ?? "" : "");

  const copy = () => {
    navigator.clipboard?.writeText(result).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  };

  return (
    <div className={`tool ${item.isError ? "error" : ""} ${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-state">
          {item.status === "running" ? <Spinner label="running" /> : item.isError ? <span className="st bad" role="img" aria-label="failed">✕</span> : <span className="st ok" role="img" aria-label="done">✓</span>}
        </span>
        <ToolIcon name={item.name} />
        <span className="tool-display">{item.display}</span>
        {stats && !item.isError && <span className="tool-outcome"><span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span></span>}
        <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d={open ? "M6 9l6 6 6-6" : "M9 6l6 6-6 6"} />
        </svg>
      </button>
      {firstError && !open && <div className={`tool-err ${denied ? "denied" : ""}`}>{firstError}</div>}
      {editsFile && item.status === "done" && !item.isError && (
        <button className="link" onClick={() => patch({ rightTab: "changes", rightOpen: true, selectedChange: path })}>
          View diff
        </button>
      )}
      {open && (
        <div className="tool-body">
          {item.result !== null && (
            <>
              <div className="label">
                {item.isError ? "Error" : "Result"}
                <button className="link" onClick={copy}>{copied ? "Copied" : "Copy output"}</button>
              </div>
              <pre>{shown}</pre>
              {!more && result.length > LIMIT && (
                <button className="link" onClick={() => setMore(true)}>
                  Show the other {result.length - LIMIT} characters
                </button>
              )}
            </>
          )}
          <button className="link" onClick={() => setShowInput(!showInput)} aria-expanded={showInput}>{showInput ? "Hide input" : "Show input"}</button>
          {showInput && <pre>{JSON.stringify(item.input, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}
