import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { formatTokens } from "../lib/lang";
import type { ContextData } from "../protocol";
import { useStore } from "../store";
import { Icon } from "./Icon";

// the items that grow with the conversation; the rest are fixed costs of the setup (and the provider's overhead)
const CONVERSATION = ["Your messages", "Model replies (text)", "Tool calls", "Tool results", "Summary"];
const isOverhead = (label: string) => label.startsWith("Provider overhead");

export function ContextPanel() {
  const running = useStore((s) => s.running);
  const compact = useStore((s) => s.compact);
  const setLimit = useStore((s) => s.setLimit);
  const turns = useStore((s) => s.info?.turns);
  const [data, setData] = useState<ContextData | null>(null);
  const [limit, setLimitText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<ContextData>("context").then((d) => { setData(d); setLimitText(String(d.limit)); setError(null); }).catch((e: Error) => setError(e.message));
  }, [running, turns]);

  if (error) return <div className="cant-wrap"><div className="empty-card"><div className="cant-title">Can't read the context</div><div className="cant-body">{error}</div></div></div>;
  if (!data) return <div className="empty-panel">Loading…</div>;
  const entries = Object.entries(data.rows).filter(([, n]) => n > 0);
  const overhead = entries.find(([l]) => isOverhead(l));
  const fixed = entries.filter(([l]) => !CONVERSATION.includes(l) && !isOverhead(l));
  const convo = entries.filter(([l]) => CONVERSATION.includes(l));
  const fixedTotal = fixed.reduce((a, [, n]) => a + n, 0);
  const convoTotal = convo.reduce((a, [, n]) => a + n, 0);
  const sum = Math.max(1, fixedTotal + convoTotal + (overhead?.[1] ?? 0));
  const used = data.last_usage ? data.last_usage.input + data.last_usage.cache_read + data.last_usage.cache_write : null;
  // the limit commits on Enter or when the field loses focus; nothing is sent if it did not change
  const commit = () => {
    const n = Number(limit);
    if (n > 0 && n !== data.limit) setLimit(n);
  };

  return (
    <div className="context">
      <section className="ccard">
        <h3 className="eyebrow">Last request</h3>
        {used !== null ? (
          <>
            <div className="bignum"><span className="num">{used.toLocaleString()}</span> <span className="unit">tokens{data.window ? ` · ${((used / data.window) * 100).toFixed(1)}% of ${formatTokens(data.window)} window` : ""}</span></div>
            <div className="climit">{((used / data.limit) * 100).toFixed(1)}% of the {formatTokens(data.limit)} compaction limit</div>
          </>
        ) : (
          <p className="lead">No model call yet, so these are estimates.</p>
        )}
        <div className="stack" role="img" aria-label="What fills the context window: setup, conversation and provider overhead">
          <span className="seg-fixed" style={{ width: `${(fixedTotal / sum) * 100}%` }} />
          <span className="seg-convo" style={{ width: `${(convoTotal / sum) * 100}%` }} />
          {overhead && <span className="seg-over" style={{ width: `${(overhead[1] / sum) * 100}%` }} />}
        </div>
      </section>
      <section className="ccard strip">
        <h3 className="ccard-head">Breakdown</h3>
        <div className="ccard-body">
          <ul className="legend">
            {fixed.map(([label, n]) => (
              <li key={label}><span className="swatch seg-fixed" /><span className="label">{label}</span><span className="n">{n.toLocaleString()}</span></li>
            ))}
            {convo.length > 0 && (
              <>
                <li><span className="swatch seg-convo" /><span className="label">Conversation</span><span className="n">{convoTotal.toLocaleString()}</span></li>
                {convo.map(([label, n]) => (
                  <li key={label} className="child"><span className="label">{label}</span><span className="n">{n.toLocaleString()}</span></li>
                ))}
              </>
            )}
            {overhead && <li><span className="swatch seg-over" /><span className="label">Provider overhead</span><span className="n">{overhead[1].toLocaleString()}</span></li>}
          </ul>
          <p className="foot">
            {overhead
              ? "Estimated at about 4 characters per token. Provider overhead is the real count minus our estimate, mostly the provider's own web search instructions."
              : used !== null
                ? "Estimated at about 4 characters per token; the estimate is a little above the real count this time."
                : "Estimated at about 4 characters per token."}
          </p>
        </div>
      </section>
      <section className="ccard strip">
        <h3 className="ccard-head">Compaction</h3>
        <div className="ccard-body">
          {data.compact_disabled && (
            <div className="warnpanel alert">
              <Icon name="warning" />
              <span>Automatic compaction has switched itself off: the limit is below the fixed cost of the instructions and tools.</span>
              <button className="btn btn-xs" onClick={() => field.current?.focus()}>Set limit</button>
            </div>
          )}
          <label className="climit-label" htmlFor="compact-at">Auto-compact at</label>
          <div className="ctl">
            <input id="compact-at" ref={field} className="field mono" inputMode="numeric" value={limit ? Number(limit).toLocaleString() : ""}
              onChange={(e) => setLimitText(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && commit()} onBlur={commit} />
            <button className="btn btn-sm" onClick={() => compact()} disabled={running}>Compact now</button>
          </div>
          <p className="foot">
            {data.compactions === 0 ? "Not compacted yet this session." : `Compacted ${data.compactions} time${data.compactions === 1 ? "" : "s"} this session.`}
          </p>
        </div>
      </section>
    </div>
  );
}
