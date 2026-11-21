import { useState } from "react";
import type { ToolItem } from "../lib/group";
import { groupLabel } from "../lib/group";
import { Icon } from "./Icon";
import { ToolCard } from "./ToolCard";

/** One container for a run of tool calls. Only a run of subagents gets a header (they are read-only helpers working together). */
export function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(true);
  const done = tools.filter((t) => t.status === "done").length;
  const helpers = tools.length > 1 && tools.every((t) => t.name === "subagent");
  return (
    <div className="toolgroup">
      {helpers && (
        <button className="toolgroup-head" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
          <span className="toolgroup-label">{groupLabel(tools)}</span>
          <span className="spacer" />
          <span className="tool-meta">read-only</span>
          <span className={`chip ${done === tools.length ? "ok" : "warn"}`}>{done} / {tools.length} done</span>
        </button>
      )}
      {(open || !helpers) && tools.map((t) => <ToolCard key={t.id} item={t} />)}
    </div>
  );
}
