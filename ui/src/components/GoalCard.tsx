import { useMemo } from "react";
import { goalSummary } from "../lib/goal";
import { useStore } from "../store";
import { Spinner } from "./Spinner";

/** Pinned above the thread while a goal runs. Fed by the notice prefixes; see lib/goal.ts. */
export function GoalCard() {
  const items = useStore((s) => s.items);
  const running = useStore((s) => s.running);
  const g = useMemo(() => goalSummary(items, running), [items, running]);
  if (!g) return null;
  return (
    <section className="goalcard" aria-label="Goal progress">
      <div className="goalcard-head"><Spinner /> <span className="eyebrow">Goal · round {g.round}</span></div>
      <div className="goalcard-text">{g.text}</div>
      {g.check && <div className="goalcard-line">{g.check}</div>}
      {g.reviewer && <div className="goalcard-line">{g.reviewer}</div>}
    </section>
  );
}
