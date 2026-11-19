import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { AskCard } from "./AskCard";
import { Message } from "./Message";
import { Welcome } from "./Welcome";

export function Chat() {
  const items = useStore((s) => s.items);
  const running = useStore((s) => s.running);
  const ask = useStore((s) => s.ask);
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
      {items.length === 0 && <Welcome />}
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
