import type { Item } from "../store";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

export function Message({ item }: { item: Item }) {
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
    case "assistant":
      return (
        <div className="msg assistant">
          <div className="body">
            <Markdown text={item.text} />
            {item.streaming && <span className="cursor" aria-hidden />}
          </div>
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "notice":
      return <div className="notice">{item.text}</div>;
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
