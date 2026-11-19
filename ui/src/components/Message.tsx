import type { Item } from "../store";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

export function Message({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
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
