import { useStore, type RightTab } from "../store";
import { ChangesPanel } from "./ChangesPanel";
import { ContextPanel } from "./ContextPanel";
import { FilesPanel } from "./FilesPanel";

const TABS: { id: RightTab; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "context", label: "Context" },
];

export function RightPanel() {
  const open = useStore((s) => s.rightOpen);
  const tab = useStore((s) => s.rightTab);
  const count = useStore((s) => Object.keys(s.changes).length);
  const patch = useStore((s) => s.patch);
  if (!open) return null;
  return (
    <aside className="rightpanel">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => patch({ rightTab: t.id })}>
            {t.label}{t.id === "changes" && count > 0 ? <span className="count">{count}</span> : null}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === "files" && <FilesPanel />}
        {tab === "changes" && <ChangesPanel />}
        {tab === "context" && <ContextPanel />}
      </div>
    </aside>
  );
}
