import type { ToolItem } from "../lib/group";
import { groupLabel } from "../lib/group";
import { ToolCard } from "./ToolCard";

/** One bordered block for a run of tool calls. The header only appears when there is more than one. */
export function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const done = tools.filter((t) => t.status === "done").length;
  return (
    <div className="toolgroup">
      {tools.length > 1 && (
        <div className="toolgroup-head">
          <span className="toolgroup-label">{groupLabel(tools)}</span>
          <span className="toolgroup-count">{done} of {tools.length} done</span>
        </div>
      )}
      {tools.map((t) => <ToolCard key={t.id} item={t} />)}
    </div>
  );
}
