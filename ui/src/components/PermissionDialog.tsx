import { useEffect, useRef } from "react";
import { useStore } from "../store";

/** The yes/no question before anything risky. It shows the exact action (hidden characters already made visible by the server).
 *  Deny is focused, Escape denies, and only a click on Allow approves: Enter on the page cannot. */
export function PermissionDialog() {
  const p = useStore((s) => s.permission);
  const answer = useStore((s) => s.answerPermission);
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
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="perm-title">
        <h2 id="perm-title">
          <svg className="shield" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6l8-3z" /><path d="M12 8v5M12 16v.01" />
          </svg>
          Permission needed: {p.title}
        </h2>
        <pre className="action">{p.display.join("\n")}</pre>
        {p.findings.length > 0 && (
          <ul className="findings">
            {p.findings.map((f, i) => (
              <li key={i}>⚠ Hidden: {f}</li>
            ))}
          </ul>
        )}
        <ul className="reasons">
          {p.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        {p.note && <p className="note">{p.note}</p>}
        <div className="buttons">
          <span className="keyhint"><kbd>Esc</kbd> denies</span>
          <button ref={deny} className="deny" onClick={() => answer(false)}>Deny</button>
          <button className="allow" onClick={() => answer(true)}>Allow</button>
        </div>
      </div>
    </div>
  );
}
