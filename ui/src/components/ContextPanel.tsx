import { useEffect, useState } from "react";
import { api } from "../api";
import { formatTokens } from "../lib/lang";
import type { ContextData } from "../protocol";
import { useStore } from "../store";

// the items that grow with the conversation; the rest are fixed costs of the setup
const CONVERSATION = ["Your messages", "Model replies (text)", "Tool calls", "Tool results", "Summary"];
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
  const hasOverhead = entries.some(([l]) => l.startsWith("Provider overhead"));
  const colour = (label: string) => COLORS[entries.findIndex(([l]) => l === label) % COLORS.length];
  const top = entries.filter(([l]) => !CONVERSATION.includes(l));
  const convo = entries.filter(([l]) => CONVERSATION.includes(l));
  const convoTotal = convo.reduce((a, [, n]) => a + n, 0);
  const sum = Math.max(1, entries.reduce((a, [, n]) => a + n, 0));
  const used = data.last_usage ? data.last_usage.input + data.last_usage.cache_read + data.last_usage.cache_write : null;
  return (
    <div className="context">
      <section className="ccard">
        <h3 className="eyebrow">Last request</h3>
        {used !== null ? (
          <>
            <div className="bignum"><span className="num">{used.toLocaleString()}</span> <span className="unit">tokens{data.window ? ` · ${((used / data.window) * 100).toFixed(1)}% of ${formatTokens(data.window)} window` : ""}</span></div>
            <div className="hint">{((used / data.limit) * 100).toFixed(1)}% of the {data.limit.toLocaleString()} compaction limit</div>
          </>
        ) : (
          <p className="lead">No model call yet, so these are estimates.</p>
        )}
      </section>
      <section className="ccard">
        <h3 className="eyebrow">What fills it</h3>
      <div className="stack" role="img" aria-label="What fills the context window">
        {entries.map(([label, n], i) => <span key={label} title={`${label}: ${n.toLocaleString()}`} style={{ width: `${(n / sum) * 100}%`, background: COLORS[i % COLORS.length] }} />)}
      </div>
      <ul className="rows">
        {top.map(([label, n]) => (
          <li key={label}>
            <span className="swatch" style={{ background: colour(label) }} />
            <span className="label">{label}</span>
            <span className="n">{n.toLocaleString()}</span>
          </li>
        ))}
        {convo.length > 0 && (
          <li className="group">
            <span className="swatch conv" aria-hidden />
            <span className="label">Conversation</span>
            <span className="n">{convoTotal.toLocaleString()}</span>
            <ul className="rows nested">
              {convo.map(([label, n]) => (
                <li key={label}>
                  <span className="swatch" style={{ background: colour(label) }} />
                  <span className="label">{label}</span>
                  <span className="n">{n.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
      <div className="hint">
        {hasOverhead
          ? "Estimated at about 4 characters per token. “Provider overhead” is the real count minus our estimate, mostly the provider's own web search instructions."
          : used !== null
            ? "Estimated at about 4 characters per token; the estimate is a little above the real count this time."
            : "Estimated at about 4 characters per token."}
      </div>
      </section>
      <section className="ccard">
        <h3 className="eyebrow">Compaction</h3>
      <div className="ctl">
        <label>Compact at <input inputMode="numeric" value={limit ? Number(limit).toLocaleString() : ""} onChange={(e) => setLimitText(e.target.value.replace(/\D/g, ""))} /> tokens</label>
        <button onClick={() => Number(limit) > 0 && setLimit(Number(limit))}>Set</button>
        <button onClick={() => compact()} disabled={running}>Compact now</button>
      </div>
      <div className="hint">
        Compacted {data.compactions} time{data.compactions === 1 ? "" : "s"} this session.
        {data.compact_disabled && " Automatic compaction is off: the limit is below the fixed cost of the instructions and tools."}
      </div>
      </section>
    </div>
  );
}
