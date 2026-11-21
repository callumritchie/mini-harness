import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Mode } from "../protocol";

const LABEL: Record<Mode, string> = { ask: "Ask", judge: "Judge", allow: "Allow" };

function Shield() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z" />
    </svg>
  );
}

/** The permission mode: always visible, one click to change. Picking Allow does not send anything; it opens the confirmation. */
export function PermissionMenu() {
  const info = useStore((s) => s.info);
  const setMode = useStore((s) => s.setMode);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open || !info) return;
    items.current[Math.max(0, info.modes.indexOf(info.permissions))]?.focus();
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open, info?.permissions]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!info) return null;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const move = (from: number, by: number) => items.current[(from + by + info.modes.length) % info.modes.length]?.focus();

  return (
    <div className="permmenu" ref={box}>
      <button ref={button} className={`perm ${info.permissions}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={`Permission mode: ${LABEL[info.permissions]}`} title={info.mode_help[info.permissions]} onClick={() => setOpen(!open)}>
        <Shield /> {LABEL[info.permissions]}
      </button>
      {open && (
        <div className="pop menu" role="menu" aria-label="Permission mode"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}>
          {info.modes.map((m, i) => (
            <button key={m} ref={(el) => { items.current[i] = el; }} role="menuitemradio" aria-checked={m === info.permissions}
              className={`menuitem ${m}`} tabIndex={m === info.permissions ? 0 : -1}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); move(i, 1); }
                else if (e.key === "ArrowUp") { e.preventDefault(); move(i, -1); }
              }}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                if (m !== info.permissions) setMode(m);
              }}>
              <span className="mname">{LABEL[m]}{m === info.permissions && <span aria-hidden> ✓</span>}</span>
              <span className="hint">{info.mode_help[m]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
