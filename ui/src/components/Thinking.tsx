import { useEffect, useState } from "react";
import type { Item } from "../store";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

type ThinkingItem = Extract<Item, { kind: "thinking" }>;

/** The model's reasoning (a summary the provider writes). Open while it streams, folded away once the reply starts; click to reopen. */
export function Thinking({ item }: { item: ThinkingItem }) {
  const [open, setOpen] = useState(item.streaming);
  useEffect(() => {
    if (!item.streaming) setOpen(false);
  }, [item.streaming]);

  return (
    <details className={`thought ${item.streaming ? "streaming" : ""}`} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        {item.streaming ? <Spinner size={12} /> : <Icon name="thought" size={14} />}
        <span>{item.streaming ? "Thinking…" : "Reasoning"}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="chev" />
      </summary>
      <div className="thought-text">{item.text}</div>
    </details>
  );
}
