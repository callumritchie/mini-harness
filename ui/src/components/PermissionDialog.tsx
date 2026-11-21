import { useEffect, useRef } from "react";
import { permissionTitle } from "../lib/lang";
import { useStore } from "../store";

/** Wrap the server's visible markers (⟨U+202E …⟩, ⟨ESC⟩) in <mark>; the text itself is never changed. */
function markHidden(text: string) {
  return text.split(/(⟨[^⟩]*⟩)/).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

/** The yes/no question before anything risky. It shows the exact action (hidden characters already made visible by the server).
 *  Deny is focused, Escape denies, and only a click on Allow approves: Enter on the page cannot. */
export function PermissionDialog() {
  const p = useStore((s) => s.permission);
  const answer = useStore((s) => s.answerPermission);
  const mode = useStore((s) => s.info?.permissions);
  const deny = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!p) return;
    deny.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p, answer]);

  if (!p) return null;
  return (
    <div className="overlay">
      <div className="dialog perm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="perm-eyebrow perm-title" aria-describedby="perm-paused">
        <div className="perm-head">
          <span className="tile">
            <svg className="shield" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z" /><path d="M12 8v5M12 16v.01" />
            </svg>
          </span>
          <div className="perm-titles">
            <div id="perm-eyebrow" className="eyebrow">Permission needed</div>
            <h2 id="perm-title">{permissionTitle(p.title)}</h2>
            <div id="perm-paused" className="hint">The agent is paused until you answer</div>
          </div>
          {mode && <span className={`modebadge m-${mode}`}>{mode}</span>}
        </div>
        <pre className="action">{markHidden(p.display.join("\n"))}</pre>
        {p.findings.length > 0 && (
          <ul className="findings">
            {p.findings.map((f, i) => (
              <li key={i}>⚠ Hidden: {f}</li>
            ))}
          </ul>
        )}
        {p.reasons.length > 0 && (
          <div className="why">
            <div className="eyebrow">Why you're being asked</div>
            <ul className="reasons">
              {p.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        )}
        {p.note && (
          <blockquote className="note">
            <div className="eyebrow">{mode === "judge" ? "The judge says" : "Note"}</div>
            {p.note}
          </blockquote>
        )}
        <div className="buttons">
          <span className="keyhint"><kbd>Esc</kbd> or <kbd>Enter</kbd> denies</span>
          <button ref={deny} className="deny" onClick={() => answer(false)}>Deny</button>
          <button className="allow" onClick={() => answer(true)}>Allow</button>
        </div>
      </div>
    </div>
  );
}
