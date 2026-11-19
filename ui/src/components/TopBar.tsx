import { useStore } from "../store";
import type { Mode } from "../protocol";
import { formatCost, formatTokens } from "../lib/lang";

const OTHER = "__other__";

export function TopBar() {
  const info = useStore((s) => s.info);
  const total = useStore((s) => s.totalCost);
  const last = useStore((s) => s.lastUsage);
  const demo = useStore((s) => s.demo);
  const running = useStore((s) => s.running);
  const s = useStore();
  if (!info) return <header className="topbar"><span className="muted">Connecting…</span></header>;

  const context = last ? last.input + last.cache_read + last.cache_write : 0;
  const pct = Math.min(100, Math.round((context / info.limit) * 100));
  const changeMode = (m: Mode) => {
    if (m === "allow" && !window.confirm("Allow everything? Nothing will be asked any more: commands (including deleting files), secrets and the network all run without a question.")) return;
    s.setMode(m);
  };

  return (
    <header className="topbar">
      <button className="icon" onClick={() => s.patch({ sidebarOpen: !s.sidebarOpen })} aria-label="Toggle sessions">☰</button>
      <div className="project" title={info.project}>{info.project.split("/").pop()}</div>
      {demo && <span className="badge demo">DEMO</span>}
      <div className="spacer" />

      <label className="field">Model
        <select className="model" value={info.model} disabled={running} title={info.models.find((m) => m.id === info.model)?.note}
          onChange={(e) => {
            if (e.target.value !== OTHER) return s.setModel(e.target.value);
            const name = window.prompt("Model id (for example claude-sonnet-4-6):")?.trim();
            if (name && name !== info.model) s.setModel(name);
          }}>
          {!info.models.some((m) => m.id === info.model) && <option value={info.model}>{info.model}</option>}
          {info.models.map((m) => <option key={m.id} value={m.id} title={m.note}>{m.id}</option>)}
          <option value={OTHER}>Other…</option>
        </select>
      </label>
      <label className="field">Effort
        <select value={info.effort ?? "default"} onChange={(e) => s.setEffort(e.target.value === "default" ? null : e.target.value)}>
          <option value="default">default</option>
          {info.efforts.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </label>
      <div className="seg" role="group" aria-label="Permissions" title={info.mode_help[info.permissions]}>
        {info.modes.map((m) => (
          <button key={m} className={`${m === info.permissions ? "on" : ""} ${m === "allow" ? "danger" : ""}`} onClick={() => changeMode(m)} aria-pressed={m === info.permissions}>{m}</button>
        ))}
      </div>

      <div className="meter" title={`Context: ${context.toLocaleString()} tokens in the last request; compaction starts at ${info.limit.toLocaleString()}`}>
        <div className="bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
        <span>{formatTokens(context)} / {formatTokens(info.limit)}</span>
      </div>
      <div className="cost" title={total?.note ?? "Cost of this session"}>
        {!info.price_known && !total?.usd ? "cost unknown" : formatCost(total?.usd ?? 0, total?.complete ?? true)}
      </div>
      <button className="icon" onClick={() => s.patch({ rightOpen: !s.rightOpen })} aria-label="Toggle side panel">▥</button>
    </header>
  );
}
