import { useStore } from "../store";
import { formatCost } from "../lib/lang";
import type { SessionRow } from "../protocol";
import { Logo } from "./Logo";

function groups(sessions: SessionRow[]) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = sessions.filter((s) => new Date(s.when) >= start);
  const earlier = sessions.filter((s) => new Date(s.when) < start);
  return [["Today", today], ["Earlier", earlier]] as const;
}

export function Sidebar() {
  const open = useStore((s) => s.sidebarOpen);
  const sessions = useStore((s) => s.sessions);
  const info = useStore((s) => s.info);
  const running = useStore((s) => s.running);
  const newSession = useStore((s) => s.newSession);
  const resume = useStore((s) => s.resume);
  const patch = useStore((s) => s.patch);
  if (!open) return null;
  return (
    <>
      <div className="backdrop" onClick={() => patch({ sidebarOpen: false })} aria-hidden />
      <aside className="sidebar" aria-label="Sessions">
        <div className="brand"><Logo /> Mini Harness</div>
        <button className="new" onClick={newSession} disabled={running}>＋ New session</button>
        <button className="ghost goal" onClick={() => patch({ showGoal: true })} disabled={running}>◎ Goal mode…</button>
        {sessions.length === 0 && <div className="muted pad">No sessions yet</div>}
        <div className="sessions-wrap" style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          {groups(sessions).map(([label, rows]) =>
            rows.length === 0 ? null : (
              <div key={label}>
                <div className="section">{label}</div>
                <ul className="sessions">
                  {rows.map((s) => (
                    <li key={s.id}>
                      <button className={s.current ? "current" : ""} disabled={running} onClick={() => !s.current && resume(s.id)} title={s.title}>
                        <span className="title">{s.title}</span>
                        <span className="sub">{new Date(s.when).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · {s.prompts} prompt{s.prompts === 1 ? "" : "s"}{s.cost ? ` · ${formatCost(s.cost)}` : ""}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
        {info && (
          <div className="side-foot">
            {info.agents_md && <div>AGENTS.md loaded</div>}
            {info.skills.length > 0 && <div>{info.skills.length} skill{info.skills.length === 1 ? "" : "s"}</div>}
            {info.mcp_tools.length > 0 && <div>{info.mcp_tools.length} MCP tool{info.mcp_tools.length === 1 ? "" : "s"}</div>}
          </div>
        )}
      </aside>
    </>
  );
}
