import { useEffect, useRef } from "react";
import { useStore } from "../store";

/** The confirmation before Allow mode. Focus starts on "Keep <mode>"; Escape and Enter keep the current mode,
 *  and only a click on "Turn on Allow" sends the change. */
export function ConfirmAllow() {
  const show = useStore((s) => s.confirmAllow);
  const mode = useStore((s) => s.info?.permissions ?? "ask");
  const patch = useStore((s) => s.patch);
  const turnOn = useStore((s) => s.confirmAllowMode);
  const keep = useRef<HTMLButtonElement>(null);
  const on = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!show) return;
    keep.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "Enter" && e.target !== on.current)) {
        e.preventDefault();
        patch({ confirmAllow: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, patch]);

  if (!show) return null;
  return (
    <div className="overlay">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="allow-title" aria-describedby="allow-body">
        <h2 id="allow-title">Turn on Allow?</h2>
        <p id="allow-body" className="hint">
          Nothing will be asked any more. Commands (including deleting files), secrets and the network all run without a question, as you.
        </p>
        <div className="buttons">
          <span className="keyhint"><kbd>Esc</kbd> or <kbd>Enter</kbd> keeps {mode}</span>
          <button ref={keep} className="deny" onClick={() => patch({ confirmAllow: false })}>Keep {mode}</button>
          <button ref={on} className="allow danger" onClick={turnOn}>Turn on Allow</button>
        </div>
      </div>
    </div>
  );
}
