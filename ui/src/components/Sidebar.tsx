import { useStore } from "../store";
import { formatCost } from "../lib/lang";

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
    <aside className="sidebar">
      <div className="brand"><span className="logo">✦</span> mini-harness</div>
      <button className="new" onClick={newSession} disabled={running}>＋ New session</button>
      <button className="ghost goal" onClick={() => patch({ showGoal: true })} disabled={running}>◎ Goal mode…</button>
      <div className="section">Sessions</div>
      <ul className="sessions">
        {sessions.length === 0 && <li className="muted pad">Nothing yet</li>}
        {sessions.map((s) => (
          <li key={s.id}>
            <button className={s.current ? "current" : ""} disabled={running} onClick={() => !s.current && resume(s.id)} title={s.title}>
              <span className="title">{s.title}</span>
              <span className="sub">{new Date(s.when).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · {s.prompts} prompt{s.prompts === 1 ? "" : "s"}{s.cost ? ` · ${formatCost(s.cost)}` : ""}</span>
            </button>
          </li>
        ))}
      </ul>
      {info && (
        <div className="side-foot">
          {info.agents_md && <div>AGENTS.md loaded</div>}
          {info.skills.length > 0 && <div>{info.skills.length} skill{info.skills.length === 1 ? "" : "s"}</div>}
          {info.mcp_tools.length > 0 && <div>{info.mcp_tools.length} MCP tool{info.mcp_tools.length === 1 ? "" : "s"}</div>}
        </div>
      )}
    </aside>
  );
}
