import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { Mode } from "../protocol";
import { Icon } from "./Icon";
import { MODE_ICON } from "./PermissionDialog";

const LABEL: Record<Mode, string> = { ask: "Ask", judge: "Judge", allow: "Allow" };

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
      <button ref={button} className={`perm m-${info.permissions}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={`Permission mode: ${LABEL[info.permissions]}`} title={info.mode_help[info.permissions]} onClick={() => setOpen(!open)}>
        <Icon name={MODE_ICON[info.permissions]} /> {LABEL[info.permissions]} <Icon name="chevron-down" size={10} strokeWidth={1.8} />
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
            <div key={m} className="menuitem-wrap" role="none">
              {m === "allow" && <div className="menu-sep" aria-hidden />}
              <button ref={(el) => { items.current[i] = el; }} role="menuitemradio" aria-checked={m === info.permissions}
                aria-label={LABEL[m]} aria-describedby={`mode-help-${m}`}
                className={`menuitem m-${m} ${m === info.permissions ? "current" : ""}`} tabIndex={m === info.permissions ? 0 : -1}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); move(i, 1); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); move(i, -1); }
                }}
                onClick={() => {
                  setOpen(false);
                  button.current?.focus();
                  if (m !== info.permissions) setMode(m);
                }}>
                <Icon name={MODE_ICON[m]} size={18} className="micon" />
                <span className="mtext">
                  <span className="mname">{LABEL[m]}<span className="mmeta">{m === info.permissions ? "Current" : m === "allow" ? "Asks to confirm" : ""}</span></span>
                  <span className="hint" id={`mode-help-${m}`}>{info.mode_help[m]}</span>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
