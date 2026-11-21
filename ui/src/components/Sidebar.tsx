import { useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { formatCost } from "../lib/lang";
import type { SessionRow } from "../protocol";
import { Icon } from "./Icon";
import { Logo } from "./Logo";

const when = (iso: string, today: boolean) =>
  today ? new Date(iso).toLocaleTimeString([], { timeStyle: "short" }) : new Date(iso).toLocaleDateString([], { dateStyle: "medium" });

/** A session with no prompt yet is not listed: there is nothing to come back to. */
export function listed(sessions: SessionRow[]) {
  return sessions.filter((s) => s.prompts > 0);
}

/** Sessions whose title contains the query (case-insensitive); an empty query keeps them all. */
export function searchSessions(sessions: SessionRow[], query: string) {
  const q = query.trim().toLowerCase();
  return q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
}

function groups(sessions: SessionRow[]) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = sessions.filter((s) => new Date(s.when) >= start);
  const earlier = sessions.filter((s) => new Date(s.when) < start);
  return [["Today", today], ["Earlier", earlier]] as const;
}

export function Sidebar() {
  const open = useStore((s) => s.sidebarOpen);
  const all = useStore((s) => s.sessions);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const sessions = useMemo(() => searchSessions(listed(all), query), [all, query]);
  const info = useStore((s) => s.info);
  const running = useStore((s) => s.running);
  const newSession = useStore((s) => s.newSession);
  const resume = useStore((s) => s.resume);
  const compact = useStore((s) => s.compact);
  const patch = useStore((s) => s.patch);
  if (!open) return null;

  const toggleSearch = () => {
    if (searching) {
      setSearching(false);
      setQuery("");
    } else {
      setSearching(true);
      setTimeout(() => field.current?.focus(), 0);
    }
  };

  return (
    <>
      <div className="backdrop" onClick={() => patch({ sidebarOpen: false })} aria-hidden />
      <aside className="sidebar" aria-label="Sessions">
        <div className="brand" title={info?.project}>
          <Logo /> <span className="brand-name">{info ? info.project.split("/").pop() : "Mini Harness"}</span>
          <button className="btn-icon drawer-close" onClick={() => patch({ sidebarOpen: false })} aria-label="Close sessions"><Icon name="close" /></button>
        </div>
        <div className="new-row">
          <button className="new" onClick={newSession} disabled={running}><Icon name="pencil" /> New session <kbd>⌘N</kbd></button>
          <button className={`btn-icon search ${searching ? "on" : ""}`} onClick={toggleSearch} aria-label="Search sessions" aria-expanded={searching}><Icon name="search" /></button>
        </div>
        {searching && (
          <input ref={field} className="field search-field" type="search" value={query} placeholder="Search session titles" aria-label="Search session titles"
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && toggleSearch()} />
        )}
        <div className="actions">
          <button onClick={() => patch({ showGoal: true })} disabled={running}><Icon name="goal" /> <span>Start a goal…</span> <code>/goal</code></button>
          <button onClick={() => compact()} disabled={running}><Icon name="compact" /> <span>Compact now</span> <code>/compact</code></button>
        </div>
        <div className="sessions-wrap">
          {sessions.length === 0 && <div className="sessions-empty">{query ? `No session titles match “${query}”.` : "No sessions yet"}</div>}
          {groups(sessions).map(([label, rows]) =>
            rows.length === 0 ? null : (
              <div key={label} className={`group ${label === "Earlier" ? "earlier" : ""}`}>
                <div className="section"><span>{label}</span><span className="count-n">{rows.length}</span></div>
                <ul className="sessions">
                  {rows.map((s) => {
                    const goal = s.title.startsWith("GOAL:");
                    const title = goal ? s.title.replace(/^GOAL:\s*/, "") : s.title;
                    return (
                      <li key={s.id}>
                        <button className={s.current ? "current is-selected" : ""} disabled={running} onClick={() => !s.current && resume(s.id)} title={s.title}>
                          <span className="title">{goal && <span className="goal-tag">GOAL</span>}{title}</span>
                          {label === "Today" && (
                            <span className="sub">{when(s.when, true)} · {s.prompts} prompt{s.prompts === 1 ? "" : "s"}{s.cost ? ` · ${formatCost(s.cost)}` : ""}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ),
          )}
        </div>
        {info && (info.agents_md || info.skills.length > 0 || info.mcp_tools.length > 0) && (
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
