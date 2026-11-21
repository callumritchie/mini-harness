import type { Item } from "../store";
import { classifyNotice } from "../lib/notice";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

const NEXT_STEP = {
  stopped: "Files already written stay on disk. Send your message again to retry.",
  unfinished: "Type continue to pick up from here.",
  cutoff: "Type continue to let it carry on.",
};

function Retry() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />
    </svg>
  );
}

export function Message({ item, compacting }: { item: Item; compacting?: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          <span className="avatar" aria-hidden>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" /></svg>
          </span>
          <div className="bubble">{item.text}</div>
        </div>
      );
    case "assistant": {
      const goal = item.text.startsWith("GOAL NOT DONE") ? "notdone" : item.text.startsWith("GOAL DONE") ? "done" : null;
      if (goal && !item.streaming) {
        return (
          <div className={`outcome ${goal}`}>
            <div className="eyebrow">{goal === "done" ? "Goal done" : "Goal not done"}</div>
            <Markdown text={item.text} />
          </div>
        );
      }
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
        return (
          <div className={`ending ${item.tone}`}>
            <span className="ending-text">{item.text}</span>
            <span className="ending-next">{NEXT_STEP[item.tone]}</span>
          </div>
        );
      }
      const kind = classifyNotice(item.text);
      if (kind === "retry") return <div className="notice retry"><Retry /> {item.text.trim()}</div>;
      if (kind === "compacting") return <div className="notice compacting">{compacting && <span className="spinner" aria-hidden />} {item.text.trim()}</div>;
      if (kind === "compacted") return <div className="divider"><span>{item.text.trim()}</span></div>;
      return <div className="notice">{item.text}</div>;
    }
    case "summary":
      return (
        <details className="summary">
          <summary>Earlier conversation, summarised</summary>
          <Markdown text={item.text} />
        </details>
      );
    case "error":
      return <div className="error-line" role="alert">{item.text}</div>;
  }
}
