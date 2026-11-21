import { useStore } from "../store";
import { formatCost } from "../lib/lang";
import type { SessionRow } from "../protocol";
import { Logo } from "./Logo";

const when = (iso: string, today: boolean) =>
  today ? new Date(iso).toLocaleTimeString([], { timeStyle: "short" }) : new Date(iso).toLocaleDateString([], { dateStyle: "medium" });

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
  const compact = useStore((s) => s.compact);
  const patch = useStore((s) => s.patch);
  if (!open) return null;
  return (
    <>
      <div className="backdrop" onClick={() => patch({ sidebarOpen: false })} aria-hidden />
      <aside className="sidebar" aria-label="Sessions">
        <div className="brand" title={info?.project}><Logo /> <span className="brand-name">{info ? info.project.split("/").pop() : "Mini Harness"}</span></div>
        <button className="new" onClick={newSession} disabled={running}>＋ New session <kbd>⌘N</kbd></button>
        <div className="actions">
          <button onClick={() => patch({ showGoal: true })} disabled={running}>◎ Start a goal…</button>
          <button onClick={() => compact()} disabled={running}>Compact now</button>
        </div>
        {sessions.length === 0 && <div className="muted pad">No sessions yet</div>}
        <div className="sessions-wrap" style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          {groups(sessions).map(([label, rows]) =>
            rows.length === 0 ? null : (
              <div key={label}>
                <div className="section">{label} <span className="count-n">{rows.length}</span></div>
                <ul className="sessions">
                  {rows.map((s) => (
                    <li key={s.id}>
                      <button className={s.current ? "current" : ""} disabled={running} onClick={() => !s.current && resume(s.id)} title={s.title}>
                        <span className="title">{s.title.startsWith("GOAL:") && <span className="tag goal-tag">GOAL</span>}{s.title}</span>
                        <span className="sub">{when(s.when, label === "Today")} · {s.prompts} prompt{s.prompts === 1 ? "" : "s"}{s.cost ? ` · ${formatCost(s.cost)}` : ""}</span>
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
            {info.agents_md && <span className="fchip">AGENTS.md loaded</span>}
            {info.skills.length > 0 && <span className="fchip">{info.skills.length} skill{info.skills.length === 1 ? "" : "s"}</span>}
            {info.mcp_tools.length > 0 && <span className="fchip">{info.mcp_tools.length} MCP tool{info.mcp_tools.length === 1 ? "" : "s"}</span>}
          </div>
        )}
      </aside>
    </>
  );
}
