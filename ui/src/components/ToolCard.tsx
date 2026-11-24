import { useMemo, useState } from "react";
import { useStore, type Item } from "../store";
import type { ToolItem } from "../lib/group";
import { diffRows, diffStats } from "../lib/diff";
import { Icon } from "./Icon";
import { ToolIcon } from "./ToolIcon";
import { Spinner } from "./Spinner";
import { DiffRows } from "./DiffView";
import { Markdown } from "./Markdown";
import { splitPath } from "./PathLabel";
import { Sources } from "./Sources";
import { GraphCard } from "./GraphCard";

const LIMIT = 4000;
const MCP_MARK = "[output from MCP server";

/** The tool call the open approval is about: the server names it; an older server leaves us the latest call still running. */
function waitingId(items: Item[], toolId: string | null | undefined): string | null {
  if (toolId) return toolId;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.status === "running") return it.id;
  }
  return null;
}

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

/** The call's one-line summary. For a file tool in a folder, the path in it is shown by its file name, with the folder after the
 *  call and dimmed ("write_file(c.json, 12 chars)  src/a/b"): deep paths share their start, so the end is what tells calls apart. */
export function ToolDisplay({ display, name, path }: { display: string; name: string; path: string | null }) {
  const at = path && FILE_TOOLS.has(name) ? display.indexOf(`(${path}`) : -1;
  const { dir, base } = path ? splitPath(path) : { dir: "", base: "" };
  if (at < 0 || !dir) return <span className="tool-display" title={display}><span className="td-main">{display}</span></span>;
  const start = at + 1;
  return (
    <span className="tool-display" title={display}>
      <span className="td-main">{display.slice(0, start)}{base}{display.slice(start + path!.length)}</span>
      <span className="sr-only">, in </span><span className="td-dir">{dir}</span>
    </span>
  );
}

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const [copied, setCopied] = useState(false);
  const patch = useStore((s) => s.patch);
  const waiting = useStore((s) => (s.permission ? waitingId(s.items, s.permission.toolId) : null)) === item.id;
  const path = typeof item.input.path === "string" ? item.input.path : null;
  const editsFile = (item.name === "write_file" || item.name === "edit_file") && path;
  // this call's own change; the session's whole change to the file is in the Changes tab
  const change = editsFile ? item.change : undefined;
  const rows = useMemo(() => (change ? diffRows(change.before, change.after) : null), [change]);
  const stats = rows ? diffStats(rows) : null;
  const result = item.result ?? "";
  const shown = more || result.length <= LIMIT ? result : result.slice(0, LIMIT);
  const mcp = item.mcp || result.startsWith(MCP_MARK);
  const command = item.name === "bash" && typeof item.input.command === "string" ? item.input.command : null;
  const plan = item.name === "exit_plan_mode" && typeof item.input.plan === "string" ? item.input.plan : null;
  // the result text is written for the model; the row's summary is written for the person
  const nextStep = item.isError && !item.denied ? result.split("\n").find((l) => l.trim()) ?? "" : "";

  const copy = () => {
    navigator.clipboard?.writeText(result).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  };

  let outcome: React.ReactNode = null;
  if (item.denied) outcome = <span className="chip bad">{item.denied === "judge" ? "judge denied" : item.denied === "rule" ? "denied" : "you denied"}</span>;
  else if (waiting) outcome = <span className="chip accent">waiting for you</span>;
  else if (item.status === "running") outcome = <span className="tool-meta">running</span>;
  else {
    const meta = stats && !item.isError
      ? <span className="tool-outcome"><span className="add">+{stats.added}</span>{change?.before !== null && <> <span className="del">−{stats.removed}</span></>}</span>
      : item.outcome ? <span className={`tool-meta ${item.isError ? "bad" : ""}`}>{item.outcome}</span>
      : item.isError ? <span className="tool-meta bad">failed</span> : null;
    const who = item.approval?.allowed ? { user: "you allowed", judge: "judge allowed", rule: "allowed by rule" }[item.approval.by] : null;
    outcome = <>{meta}{who && <span className={`chip ${item.approval?.by === "judge" ? "warn" : ""}`}>{who}</span>}</>;
  }
  const sub = item.name === "subagent" && (item.steps?.length || item.finish)
    ? [item.steps?.length ? `↳ ${item.steps[item.steps.length - 1]}` : null,
       item.finish ? `finished: ${item.finish.calls} model call${item.finish.calls === 1 ? "" : "s"}, ${item.finish.cost == null ? "cost unknown" : `$${item.finish.cost.toFixed(4)}`}` : null].filter(Boolean).join(" · ")
    : "";

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
        <ToolDisplay display={item.display} name={item.name} path={path} />
        <span className="tool-right">{outcome}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="chev" />
      </button>
      {sub && <div className="tool-sub">{item.index != null && <span className="muted">[{item.index}] </span>}{sub}</div>}
      {nextStep && !open && <div className="tool-err">{nextStep}</div>}
      {open && (
        <div className="tool-body">
          {command !== null && <pre className="tool-cmd"><span className="muted">$ </span>{command}</pre>}
          {plan !== null && <div className="tool-plan"><Markdown text={plan} /></div>}
          {rows && !item.isError && (
            <div className="diff tool-diff" aria-label={`What this call changed in ${path}`}>
              <DiffRows rows={rows} wrap headers={false} />
            </div>
          )}
          {/* search_docs: the ranked passages instead of the text written for the model (Copy output still copies that) */}
          {item.sources?.length ? <Sources sources={item.sources} />
            : item.graph ? <GraphCard graph={item.graph} inTool onPick={(name) => patch({ rightTab: "knowledge", rightOpen: true, knowledgeQuery: name })} />
            : item.result !== null && (
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
            {!more && !item.sources?.length && !item.graph && result.length > LIMIT && (
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
