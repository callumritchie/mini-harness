import { useEffect, useRef } from "react";
import type { Mode } from "../protocol";
import { useStore } from "../store";
import { Icon } from "./Icon";

const LABEL: Record<Mode, string> = { ask: "Ask", judge: "Judge", allow: "Allow" };

/** The confirmation before Allow mode. Focus starts on "Keep <mode>"; Escape and Enter keep the current mode,
 *  and only a click on "Turn on Allow" sends the change. */
export function ConfirmAllow() {
  const show = useStore((s) => s.confirmAllow);
  const mode = useStore((s) => s.info?.permissions ?? "ask");
  const project = useStore((s) => s.info?.project?.split("/").pop() || "this project");
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
      <div className="dialog sm danger" role="alertdialog" aria-modal="true" aria-labelledby="allow-title" aria-describedby="allow-body">
        <div className="dbody roomy">
          <div className="dhead flat">
            <span className="tile bad"><Icon name="shield-x" size={18} /></span>
            <h2 id="allow-title">Turn on Allow?</h2>
          </div>
          <div id="allow-body" className="allow-copy">
            <p>Nothing will be asked any more. Everything the agent decides to do runs straight away, as you:</p>
            <ul>
              <li>Commands run without a question, including ones that delete files in <code>{project}</code> or outside it.</li>
              <li>Files that look like secrets can be read.</li>
              <li>The network can be used.</li>
            </ul>
            <p className="muted">You can switch back at any time from the permission button or the red strip above the message box.</p>
          </div>
        </div>
        <div className="dfoot">
          <span className="keyhint">Esc or Enter keeps {LABEL[mode]}</span>
          <button ref={keep} className="btn deny" onClick={() => patch({ confirmAllow: false })}>Keep {LABEL[mode]}</button>
          <button ref={on} className="btn btn-danger" onClick={turnOn}>Turn on Allow</button>
        </div>
      </div>
    </div>
  );
}
