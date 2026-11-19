import { useStore } from "../store";
import type { Mode } from "../protocol";
import { formatCost, formatTokens } from "../lib/lang";
import { SettingsMenu } from "./SettingsMenu";

export function TopBar() {
  const info = useStore((s) => s.info);
  const total = useStore((s) => s.totalCost);
  const last = useStore((s) => s.lastUsage);
  const demo = useStore((s) => s.demo);
  const s = useStore();
  if (!info) return <header className="topbar"><span className="muted">Connecting…</span></header>;

  const context = last ? last.input + last.cache_read + last.cache_write : 0;
  const pct = Math.min(100, Math.round((context / info.limit) * 100));
  const changeMode = (m: Mode) => {
    if (m === "allow" && !window.confirm("Allow everything? Nothing will be asked any more: commands (including deleting files), secrets and the network all run without a question.")) return;
    s.setMode(m);
  };

  return (
    <>
      <header className="topbar">
        <button className="icon" onClick={() => s.patch({ sidebarOpen: !s.sidebarOpen })} aria-label="Toggle sessions" title="Sessions (⌘B)">☰</button>
        <div className="project" title={info.project}>{info.project.split("/").pop()}</div>
        {demo && <span className="badge demo">DEMO</span>}
        <div className="spacer" />

        <div className="chip" title={`${info.model}. Context: ${context.toLocaleString()} of ${info.limit.toLocaleString()} tokens in the last request`}>
          <span className="model">{info.model}</span>
          <span className="dot d1">·</span>
          <span className="cost" title={total?.note ?? "Cost of this session"}>
            {!info.price_known && !total?.usd ? "cost unknown" : formatCost(total?.usd ?? 0, total?.complete ?? true)}
          </span>
          <span className="dot d2">·</span>
          <span className="ctx">{formatTokens(context)} / {formatTokens(info.limit)}</span>
        </div>
        <div className="seg" role="group" aria-label="Permissions" title={info.mode_help[info.permissions]}>
          {info.modes.map((m) => (
            <button key={m} className={`${m === info.permissions ? "on" : ""} ${m === "allow" ? "danger" : ""}`} onClick={() => changeMode(m)} aria-pressed={m === info.permissions}>{m}</button>
          ))}
        </div>
        <SettingsMenu />
        <button className="icon" onClick={() => s.patch({ rightOpen: !s.rightOpen })} aria-label="Toggle side panel" title="Files, changes, context">▥</button>
      </header>
      <div className="contextbar" role="progressbar" aria-label="Context used" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`fill ${pct >= 80 ? "high" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}
