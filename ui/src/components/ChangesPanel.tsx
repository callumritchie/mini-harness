import { useMemo } from "react";
import { diffRows, diffStats } from "../lib/diff";
import { useStore } from "../store";
import { DiffView } from "./DiffView";

export function ChangesPanel() {
  const changes = useStore((s) => s.changes);
  const selected = useStore((s) => s.selectedChange);
  const patch = useStore((s) => s.patch);
  const paths = Object.keys(changes);
  const stats = useMemo(
    () => Object.fromEntries(paths.map((p) => [p, diffStats(diffRows(changes[p].before, changes[p].after))])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changes],
  );
  if (paths.length === 0) return <div className="empty-panel">Files the agent writes or edits in this session appear here, with a diff.</div>;
  const current = selected && changes[selected] ? selected : paths[0];
  return (
    <div className="changes">
      <ul className="change-list">
        {paths.map((p) => (
          <li key={p}>
            <button className={p === current ? "on" : ""} onClick={() => patch({ selectedChange: p })}>
              <span className="name">{p}</span>
              <span className="add">+{stats[p].added}</span> <span className="del">−{stats[p].removed}</span>
            </button>
          </li>
        ))}
      </ul>
      <DiffView path={current} before={changes[current].before} after={changes[current].after} />
    </div>
  );
}
