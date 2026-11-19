import { useEffect, useState } from "react";
import { api } from "../api";
import { formatTokens } from "../lib/lang";
import type { ContextData } from "../protocol";
import { useStore } from "../store";

const COLORS = ["#6366f1", "#14b8a6", "#f59e0b", "#ec4899", "#22c55e", "#0ea5e9", "#a855f7", "#ef4444", "#84cc16", "#64748b"];

export function ContextPanel() {
  const running = useStore((s) => s.running);
  const compact = useStore((s) => s.compact);
  const setLimit = useStore((s) => s.setLimit);
  const turns = useStore((s) => s.info?.turns);
  const [data, setData] = useState<ContextData | null>(null);
  const [limit, setLimitText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<ContextData>("context").then((d) => { setData(d); setLimitText(String(d.limit)); setError(null); }).catch((e: Error) => setError(e.message));
  }, [running, turns]);

  if (error) return <div className="error-line">{error}</div>;
  if (!data) return <div className="empty-panel">Loading…</div>;
  const entries = Object.entries(data.rows).filter(([, n]) => n > 0);
  const sum = Math.max(1, entries.reduce((a, [, n]) => a + n, 0));
  const used = data.last_usage ? data.last_usage.input + data.last_usage.cache_read + data.last_usage.cache_write : null;
  return (
    <div className="context">
      <p className="hint">
        {used !== null ? <>The last request used <b>{used.toLocaleString()}</b> tokens{data.window ? <> ({((used / data.window) * 100).toFixed(1)}% of the {formatTokens(data.window)} window)</> : null}.</> : "No model call yet, so these are estimates."}
      </p>
      <div className="stack" role="img" aria-label="What fills the context window">
        {entries.map(([label, n], i) => <span key={label} title={`${label}: ${n.toLocaleString()}`} style={{ width: `${(n / sum) * 100}%`, background: COLORS[i % COLORS.length] }} />)}
      </div>
      <ul className="rows">
        {entries.map(([label, n], i) => (
          <li key={label}>
            <span className="swatch" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="label">{label}</span>
            <span className="n">{n.toLocaleString()}</span>
          </li>
        ))}
      </ul>
      <div className="hint">Estimated at about 4 characters per token. “Provider overhead” is the real count minus our estimate, mostly the provider's own web search instructions.</div>
      <div className="ctl">
        <label>Compact at <input value={limit} onChange={(e) => setLimitText(e.target.value.replace(/\D/g, ""))} /> tokens</label>
        <button onClick={() => Number(limit) > 0 && setLimit(Number(limit))}>Set</button>
        <button onClick={() => compact()} disabled={running}>Compact now</button>
      </div>
      <div className="hint">
        Compacted {data.compactions} time{data.compactions === 1 ? "" : "s"} this session.
        {data.compact_disabled && " Automatic compaction is off: the limit is below the fixed cost of the instructions and tools."}
      </div>
    </div>
  );
}
