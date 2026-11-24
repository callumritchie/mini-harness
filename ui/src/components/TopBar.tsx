import { activity } from "../lib/knowledgeWords";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";
import { PermissionMenu } from "./PermissionMenu";
import { SettingsMenu } from "./SettingsMenu";

export function TopBar() {
  const info = useStore((s) => s.info);
  const last = useStore((s) => s.lastUsage);
  const demo = useStore((s) => s.demo);
  const sessionTitle = useStore((s) => {
    const row = s.sessions.find((r) => r.current);
    return row ? (row.prompts === 0 ? "New session" : row.title.replace(/^GOAL:\s*/, "")) : undefined;
  });
  const s = useStore();
  const indexing = activity(s.indexStatus); // shown only while the index, its vectors or the map are being updated
  if (!info) return <header className="topbar"><span className="muted">Connecting…</span></header>;

  const context = last ? last.input + last.cache_read + last.cache_write : 0;
  const pct = Math.min(100, Math.round((context / info.limit) * 100));

  return (
    <>
      <header className="topbar">
        {/* only shown when the session list is not already beside the chat (narrow windows, or closed with ⌘B) */}
        <button className={`btn-icon sessions-toggle ${s.sidebarOpen ? "docked" : ""}`} onClick={() => s.patch({ sidebarOpen: !s.sidebarOpen, sidebarInstant: false })}
          aria-label="Toggle sessions" title="Sessions (⌘B)"><Icon name="menu" size={16} /></button>
        <div className="project" title={info.project}>
          <span className="crumb-project">{info.project.split("/").pop()}</span>
          {sessionTitle && <><Icon name="chevron-right" size={12} className="crumb-sep" /><span className="crumb-title">{sessionTitle}</span></>}
        </div>
        {demo && <span className="badge demo">DEMO</span>}
        <div className="spacer" />
        {indexing && (
          <button className="index-activity" onClick={() => s.patch({ rightOpen: true, rightTab: "knowledge" })} title={`${indexing}: open Knowledge`}>
            <Spinner size={12} /><span className="ia-text">{indexing}</span>
          </button>
        )}

        <SettingsMenu context={context} pct={pct} />
        <PermissionMenu />
        <button className="btn-icon" onClick={() => s.patch({ rightOpen: !s.rightOpen })} aria-label="Toggle side panel" title="Files, changes, context">
          <Icon name="panel" size={16} />
        </button>
      </header>
      <div className="contextbar" role="progressbar" aria-label="Context used" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`fill ${pct >= 80 ? "high" : ""}`} style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
    </>
  );
}
