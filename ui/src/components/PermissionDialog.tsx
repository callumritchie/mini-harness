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
        <h2 id="perm-title">Permission needed: {p.title}</h2>
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
          <button ref={deny} className="deny" onClick={() => answer(false)}>Deny</button>
          <button className="allow" onClick={() => answer(true)}>Allow</button>
        </div>
      </div>
    </div>
  );
}
