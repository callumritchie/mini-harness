import { useStore } from "../store";
import { PermissionMenu } from "./PermissionMenu";
import { SettingsMenu } from "./SettingsMenu";

export function TopBar() {
  const info = useStore((s) => s.info);
  const last = useStore((s) => s.lastUsage);
  const demo = useStore((s) => s.demo);
  const sessionTitle = useStore((s) => {
    const row = s.sessions.find((r) => r.current);
    return row ? (row.prompts === 0 ? "New session" : row.title) : undefined;
  });
  const s = useStore();
  if (!info) return <header className="topbar"><span className="muted">Connecting…</span></header>;

  const context = last ? last.input + last.cache_read + last.cache_write : 0;
  const pct = Math.min(100, Math.round((context / info.limit) * 100));

  return (
    <>
      <header className="topbar">
        <button className="icon" onClick={() => s.patch({ sidebarOpen: !s.sidebarOpen })} aria-label="Toggle sessions" title="Sessions (⌘B)">☰</button>
        <div className="project" title={info.project}>
          <span className="crumb-project">{info.project.split("/").pop()}</span>
          {sessionTitle && <><span className="crumb-sep" aria-hidden>/</span><span className="crumb-title">{sessionTitle}</span></>}
        </div>
        {demo && <span className="badge demo">DEMO</span>}
        <div className="spacer" />

        <PermissionMenu />
        <SettingsMenu context={context} pct={pct} />
        <button className="icon" onClick={() => s.patch({ rightOpen: !s.rightOpen })} aria-label="Toggle side panel" title="Files, changes, context">▥</button>
      </header>
      <div className="contextbar" role="progressbar" aria-label="Context used" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`fill ${pct >= 80 ? "high" : ""}`} style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}
