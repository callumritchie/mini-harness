import { useState } from "react";
import { useStore, type Item } from "../store";
import { classifyNotice } from "../lib/notice";
import { roundLines } from "../lib/goal";
import { formatCost } from "../lib/lang";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import { Spinner } from "./Spinner";
import { Icon, type IconName } from "./Icon";
import { Marker } from "./GoalCard";

const ENDING: Record<"stopped" | "unfinished" | "cutoff", { icon: IconName; next: React.ReactNode }> = {
  stopped: { icon: "stop", next: "Files already written stay on disk." },
  unfinished: { icon: "alert-circle", next: <>Type <code>continue</code> to pick up from here.</> },
  cutoff: { icon: "cut", next: <>Type <code>continue</code> to carry on.</> },
};

/** "Stopped. That turn…" → a bold lead ("Stopped.") and the rest; the text itself is unchanged. */
function lead(text: string) {
  const m = /^([^.:]{1,20}[.:])(\s[\s\S]*)?$/.exec(text);
  return m ? <><strong>{m[1]}</strong>{m[2] ?? ""}</> : text;
}

type Assistant = Extract<Item, { kind: "assistant" }>;

function GoalOutcome({ item, span }: { item: Assistant; span?: Item[] }) {
  const [all, setAll] = useState(false);
  const goal = useStore((s) => s.goal);
  const running = useStore((s) => s.running);
  const done = item.text.startsWith("GOAL DONE");
  const rounds = /after (\d+) round/.exec(item.text)?.[1];
  const body = item.text.replace(/^GOAL (NOT )?DONE\s*/, "").replace(/^after \d+ round\(s\)\s*[:.]?\s*/, "");
  const lines = !all ? [] : item.goal?.lines?.length ? item.goal.lines : span ? roundLines(span, false) : [];
  const g = item.goal;
  return (
    <div className={`outcome ${done ? "done" : "notdone"}`}>
      <div className="outcome-title"><Icon name={done ? "check" : "alert-circle"} size={16} /> {done ? "Goal done" : "Goal not done"}</div>
      {body && <div className="outcome-body"><Markdown text={body} /></div>}
      {(rounds || g?.cost != null) && (
        <div className="outcome-meta">
          {rounds && <>{rounds} round{rounds === "1" ? "" : "s"}</>}
          {rounds && g?.cost != null && " · "}
          {g?.cost != null && formatCost(g.cost, g.complete)}
        </div>
      )}
      {lines.length > 0 && <ol className="rounds flat">{lines.map((l) => <li key={l.id}><Marker m={l.marker} /><span>{l.text}</span></li>)}</ol>}
      {(g || (span && span.length > 0)) && (
        <div className="outcome-actions">
          {g && <button className="btn btn-sm" disabled={running} onClick={() => goal(g.text, g.verify, g.maxTurns)}>Run goal again</button>}
          {(g?.lines?.length || (span && span.length > 0)) ? <button className="btn-text" onClick={() => setAll(!all)} aria-expanded={all}>{all ? "Hide rounds" : "Show all rounds"}</button> : null}
        </div>
      )}
    </div>
  );
}

export function Message({ item, compacting, span }: { item: Item; compacting?: boolean; span?: Item[] }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          <span className="avatar" aria-hidden><Icon name="user" size={12} /></span>
          <div className="bubble">{item.text}</div>
        </div>
      );
    case "assistant": {
      if (!item.streaming && item.text.startsWith("GOAL")) return <GoalOutcome item={item} span={span} />;
      return (
        <div className="msg assistant">
          <div className="body">
            <Markdown text={item.text} />
            {item.streaming && <span className="cursor" aria-hidden />}
          </div>
        </div>
      );
    }
    case "tool":
      return <ToolCard item={item} />;
    case "notice": {
      if (item.tone) {
        const e = ENDING[item.tone];
        return (
          <div className={`ending ${item.tone}`}>
            <Icon name={e.icon} className="ending-icon" />
            <span className="ending-text">{lead(item.text)} <span className="ending-next">{e.next}</span></span>
          </div>
        );
      }
      const kind = classifyNotice(item.text);
      if (kind === "retry") return <div className="notice retry"><Icon name="retry" /> {item.text.trim()}</div>;
      if (kind === "compacting") return <div className="compacting">{compacting ? <Spinner /> : <Icon name="compact" />} {item.text.trim().replace(/^●\s*/, "")}</div>;
      if (kind === "compacted") return <div className="divider"><span>{item.text.trim()}</span></div>;
      return <div className="notice">{item.text}</div>;
    }
    case "summary":
      return (
        <details className="summary">
          <summary>Summary the model now works from</summary>
          <Markdown text={item.text} />
        </details>
      );
    case "error":
      return (
        <div className="ending error" role="alert">
          <Icon name="x-circle" className="ending-icon" />
          <span className="ending-text">{lead(item.text)}</span>
        </div>
      );
  }
}
