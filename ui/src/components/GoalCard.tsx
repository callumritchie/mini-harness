import { useMemo } from "react";
import { goalSummary, roundLines, type RoundMarker } from "../lib/goal";
import { useStore } from "../store";
import { Spinner } from "./Spinner";

export function Marker({ m }: { m: RoundMarker }) {
  if (m === "spin") return <Spinner size={12} />;
  if (m === "ok") return <span className="rm ok" role="img" aria-label="passed">✓</span>;
  if (m === "bad") return <span className="rm bad" role="img" aria-label="failed">✕</span>;
  if (m === "dot") return <span className="rm" aria-hidden>·</span>;
  return <span className="rm num">{m}</span>;
}

/** Pinned above the thread while a goal runs. Rounds come from the goal notices (see lib/goal.ts); the check and turn limit are the
 *  ones this page started it with, when it did. */
export function GoalCard() {
  const items = useStore((s) => s.items);
  const running = useStore((s) => s.running);
  const run = useStore((s) => s.goalRun);
  const mode = useStore((s) => s.info?.permissions);
  const cancel = useStore((s) => s.cancel);
  const g = useMemo(() => goalSummary(items, running), [items, running]);
  const lines = useMemo(() => {
    if (!g) return [];
    let start = items.length - 1;
    while (start >= 0 && !(items[start].kind === "user" && (items[start] as { text: string }).text.startsWith("/goal"))) start--;
    return roundLines(items.slice(start + 1), true);
  }, [g, items]);
  if (!g) return null;
  return (
    <section className="goalcard" aria-label="Goal progress">
      <div className="goal-top">
        <div className="goal-headline"><span className="goal-tag">GOAL</span><span className="goal-round">Round {g.round} · working</span><Spinner /></div>
        <div className="goalcard-text">{g.text}</div>
        <div className="goal-meta">
          {run?.verify && <>Check <code>{run.verify}</code> · </>}
          {run?.maxTurns && <>up to {run.maxTurns} turns · </>}
          can't ask you questions
        </div>
      </div>
      {lines.length > 0 && (
        <ol className="rounds">
          {lines.map((l) => <li key={l.id}><Marker m={l.marker} /><span>{l.text}</span></li>)}
        </ol>
      )}
      <div className="goal-foot">
        <span>{mode === "ask" ? "In Ask mode, risky steps still wait for you." : mode === "judge" ? "The judge answers the easy questions." : "Allow is on: nothing is asked."}</span>
        <button className="btn btn-sm" onClick={cancel}>Stop goal</button>
      </div>
    </section>
  );
}
