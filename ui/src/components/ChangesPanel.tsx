import { useMemo } from "react";
import { diffRows, diffStats } from "../lib/diff";
import { useStore } from "../store";
import { DiffView } from "./DiffView";
import { PathLabel } from "./PathLabel";

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
  if (paths.length === 0) {
    return (
      <div className="cant-wrap">
        <div className="empty-card">
          <div className="cant-title">No changes yet in this session</div>
          <div className="cant-body">
            Files the agent writes or edits will appear here with a diff. Changes made before you resumed this session, or by shell commands, aren't tracked.
          </div>
        </div>
      </div>
    );
  }
  const current = selected && changes[selected] ? selected : paths[0];
  return (
    <div className="changes">
      <ul className="change-list">
        {paths.map((p) => {
          const isNew = changes[p].before === null;
          return (
            <li key={p}>
              <button className={p === current ? "is-selected" : ""} onClick={() => patch({ selectedChange: p })}>
                <PathLabel path={p} className="name" />
                {isNew && <span className="mark new">NEW</span>}
                <span className="add">+{stats[p].added}</span>{!isNew && <span className="del">−{stats[p].removed}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <DiffView path={current} before={changes[current].before} after={changes[current].after} />
    </div>
  );
}
