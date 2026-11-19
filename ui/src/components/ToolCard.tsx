import { useState } from "react";
import { useStore, type Item } from "../store";

type ToolItem = Extract<Item, { kind: "tool" }>;

const ICON: Record<string, string> = {
  read_file: "▤", write_file: "✎", edit_file: "✎", bash: "$", glob: "⌕", grep: "⌕", web_search: "◍", code_execution: "▶",
  ask_user: "?", subagent: "◇",
};
const LIMIT = 4000;

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const patch = useStore((s) => s.patch);
  const path = typeof item.input.path === "string" ? item.input.path : null;
  const editsFile = (item.name === "write_file" || item.name === "edit_file") && path;
  const result = item.result ?? "";
  const shown = more || result.length <= LIMIT ? result : result.slice(0, LIMIT);

  return (
    <div className={`tool ${item.isError ? "error" : ""} ${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool-icon">{ICON[item.name] ?? "•"}</span>
        <span className="tool-display">{item.display}</span>
        <span className="tool-state">{item.status === "running" ? <span className="spinner" aria-label="running" /> : <><span className="status-dot" aria-hidden />{item.isError ? "failed" : "done"}</>}</span>
        <span className="chev">{open ? "▾" : "▸"}</span>
      </button>
      {editsFile && item.status === "done" && !item.isError && (
        <button className="link" onClick={() => patch({ rightTab: "changes", rightOpen: true, selectedChange: path })}>
          View diff
        </button>
      )}
      {open && (
        <div className="tool-body">
          <div className="label">Input</div>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {item.result !== null && (
            <>
              <div className="label">{item.isError ? "Error" : "Result"}</div>
              <pre>{shown}</pre>
              {!more && result.length > LIMIT && (
                <button className="link" onClick={() => setMore(true)}>
                  Show the other {result.length - LIMIT} characters
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
