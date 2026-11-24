import { useEffect, useMemo, useRef } from "react";
import { groupItems, type Entry } from "../lib/group";
import { compactingId } from "../lib/notice";
import { goalSpans } from "../lib/goal";
import { useStore } from "../store";
import { AskCard } from "./AskCard";
import { GoalCard } from "./GoalCard";
import { Logo } from "./Logo";
import { Message } from "./Message";
import { PlanCard } from "./PlanCard";
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
  const plan = useStore((s) => s.plan);
  const permission = useStore((s) => s.permission);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const spans = useMemo(() => goalSpans(items, running), [items, running]);
  // goal-progress notices live in the goal card while it runs and in its result card after; the thread keeps the rest
  const entries = useMemo(() => groupItems(items.filter((it) => !spans.hidden.has(it.id))), [items, spans]);
  const compacting = useMemo(() => compactingId(items), [items]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, ask, plan, running]);

  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const isUser = (e: Entry | undefined) => !e || (e.kind !== "group" && e.kind === "user");
  const last = entries[entries.length - 1];
  const lastKind = items[items.length - 1]?.kind;
  const working = running && !ask && !plan && lastKind !== "assistant" && lastKind !== "thinking";

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
              {e.kind === "group" ? <ToolGroup tools={e.tools} /> : <Message item={e} compacting={e.id === compacting} span={spans.byOutcome.get(e.id)} />}
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
        <PlanCard />
      </div>
    </div>
  );
}
