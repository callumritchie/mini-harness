import { useEffect, useState } from "react";
import { useStore, type RightTab } from "../store";
import { ChangesPanel } from "./ChangesPanel";
import { ContextPanel } from "./ContextPanel";
import { FilesPanel } from "./FilesPanel";

const TABS: { id: RightTab; label: string }[] = [
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "context", label: "Context" },
];

const WIDTH_KEY = "mini-harness-panel-width";
const clamp = (n: number) => Math.max(280, Math.min(720, n));

function savedWidth() {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return n ? clamp(n) : 400;
  } catch {
    return 400;
  }
}

export function RightPanel() {
  const [width, setWidth] = useState(savedWidth);
  const [drag, setDrag] = useState(false);
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setWidth(clamp(window.innerWidth - e.clientX));
    const up = () => setDrag(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag]);
  useEffect(() => {
    if (drag) return;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* not remembered */
    }
  }, [drag, width]);

  const open = useStore((s) => s.rightOpen);
  const tab = useStore((s) => s.rightTab);
  const count = useStore((s) => Object.keys(s.changes).length);
  const patch = useStore((s) => s.patch);
  if (!open) return null;
  return (
    <>
    <div className="backdrop right" onClick={() => patch({ rightOpen: false })} aria-hidden />
    <aside className="rightpanel" style={{ "--right-w": `${width}px` } as React.CSSProperties}>
      <div className={`resize ${drag ? "drag" : ""}`} onPointerDown={(e) => { e.preventDefault(); setDrag(true); }} role="separator" aria-orientation="vertical" aria-label="Resize panel" />
      <div className="tabs">
        <div className="segtabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => patch({ rightTab: t.id })}>
              {t.label}{t.id === "changes" && count > 0 ? <span className="count">{count}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-body">
        {tab === "files" && <FilesPanel />}
        {tab === "changes" && <ChangesPanel />}
        {tab === "context" && <ContextPanel />}
      </div>
    </aside>
    </>
  );
}
