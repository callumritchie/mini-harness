import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { AskCard } from "./AskCard";
import { Message } from "./Message";

export function Chat() {
  const items = useStore((s) => s.items);
  const running = useStore((s) => s.running);
  const ask = useStore((s) => s.ask);
  const info = useStore((s) => s.info);
  const demo = useStore((s) => s.demo);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, ask, running]);

  const onScroll = () => {
    const el = box.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="chat" ref={box} onScroll={onScroll} role="log" aria-live="polite">
      {items.length === 0 && (
        <div className="empty">
          <div className="logo">✦</div>
          <h1>What should we work on?</h1>
          <p>
            {info ? <>Working in <code>{info.project}</code>.</> : "Connecting…"}
            {demo && " This is the demo: a scripted model, nothing is real. Try “hello”, “create a file”, then “delete it”."}
          </p>
          {info && !info.client_ready && <div className="error-line">{info.client_error ?? "No API key yet."}</div>}
          <p className="muted">Type <code>/</code> for commands. Risky actions always ask first.</p>
        </div>
      )}
      <div className="thread">
        {items.map((item) => (
          <Message key={item.id} item={item} />
        ))}
        {running && !ask && items[items.length - 1]?.kind !== "assistant" && <div className="thinking"><span className="spinner" /> Working…</div>}
        <AskCard />
      </div>
    </div>
  );
}
