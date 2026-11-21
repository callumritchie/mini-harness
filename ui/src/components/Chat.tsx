import { useEffect, useMemo, useRef } from "react";
import { groupItems, type Entry } from "../lib/group";
import { compactingId } from "../lib/notice";
import { useStore } from "../store";
import { AskCard } from "./AskCard";
import { GoalCard } from "./GoalCard";
import { Logo } from "./Logo";
import { Message } from "./Message";
import { ToolGroup } from "./ToolGroup";
import { Welcome } from "./Welcome";
import { permissionTitle } from "../lib/lang";

/** Everything after a person's message sits in one column beside the agent's mark; the mark shows once, at the top of the reply. */
function AgentRow({ first, children }: { first: boolean; children: React.ReactNode }) {
  return (
    <div className="agent-row">
      <span className="agent-mark">{first && <Logo size={22} />}</span>
      <div className="agent-body">{children}</div>
    </div>
  );
}

export function Chat() {
  const items = useStore((s) => s.items);
  const running = useStore((s) => s.running);
  const ask = useStore((s) => s.ask);
  const permission = useStore((s) => s.permission);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const entries = useMemo(() => groupItems(items), [items]);
  const compacting = useMemo(() => compactingId(items), [items]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, ask, running]);

  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const isUser = (e: Entry | undefined) => !e || (e.kind !== "group" && e.kind === "user");
  const last = entries[entries.length - 1];
  const working = running && !ask && items[items.length - 1]?.kind !== "assistant";

  return (
    <div className="chat" ref={box} onScroll={onScroll} role="log" aria-live="polite">
      <GoalCard />
      {items.length === 0 && <Welcome />}
      <div className="thread">
        {entries.map((e, i) =>
          e.kind !== "group" && e.kind === "user" ? (
            <Message key={e.id} item={e} />
          ) : (
            <AgentRow key={e.id} first={isUser(entries[i - 1])}>
              {e.kind === "group" ? <ToolGroup tools={e.tools} /> : <Message item={e} compacting={e.id === compacting} />}
            </AgentRow>
          ),
        )}
        {permission ? (
          // the paused step, in the thread behind the dialog; Review only brings focus back to the dialog's Deny
          <AgentRow first={isUser(last)}>
            <div className="paused-strip">
              <span className="wait-dot" aria-hidden />
              <span>Waiting for your approval: {permissionTitle(permission.title)}</span>
              <button className="btn btn-sm" onClick={() => document.getElementById("perm-deny")?.focus()}>Review</button>
            </div>
          </AgentRow>
        ) : working && <AgentRow first={isUser(last)}><div className="thinking">Working…</div></AgentRow>}
        <AskCard />
      </div>
    </div>
  );
}
