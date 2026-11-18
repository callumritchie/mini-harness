import { useEffect, useState } from "react";
import { api } from "../api";
import { formatTokens } from "../lib/lang";
import type { ContextData } from "../protocol";
import { useStore } from "../store";

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
  const max = Math.max(1, ...Object.values(data.rows));
  const used = data.last_usage ? data.last_usage.input + data.last_usage.cache_read + data.last_usage.cache_write : null;
  return (
    <div className="context">
      <p className="hint">
        {used !== null ? <>The last request used <b>{used.toLocaleString()}</b> tokens{data.window ? <> ({((used / data.window) * 100).toFixed(1)}% of the {formatTokens(data.window)} window)</> : null}.</> : "No model call yet, so these are estimates."}
      </p>
      <ul className="rows">
        {Object.entries(data.rows).filter(([, n]) => n > 0).map(([label, n]) => (
          <li key={label}>
            <span className="label">{label}</span>
            <span className="track"><span className="fill" style={{ width: `${(n / max) * 100}%` }} /></span>
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
