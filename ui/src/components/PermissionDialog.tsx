import { useEffect, useRef } from "react";
import { permissionTitle } from "../lib/lang";
import type { Mode } from "../protocol";
import { useStore } from "../store";
import { Icon, type IconName } from "./Icon";

/** Wrap the server's visible markers (⟨U+202E …⟩, ⟨ESC⟩) in <mark>; the text itself is never changed. */
function markHidden(text: string) {
  return text.split(/(⟨[^⟩]*⟩)/).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

const KIND_ICON: Record<string, IconName> = { bash: "terminal", write: "file", read: "file", mcp: "plug" };
export const MODE_ICON: Record<Mode, IconName> = { ask: "shield", judge: "shield-judge", allow: "shield-x" };
const MODE_LABEL: Record<Mode, string> = { ask: "Ask", judge: "Judge", allow: "Allow" };

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
  const hidden = p.findings.length > 0;
  const title = permissionTitle(p.title);
  const subtitle = p.kind === "mcp" ? "From an MCP server: what it does is that server's business"
    : mode === "judge" && p.note ? "The judge passed this to you" : "The agent is paused until you answer";
  return (
    <div className="overlay">
      <div className={`dialog perm-dialog ${hidden ? "has-findings" : ""}`} role="alertdialog" aria-modal="true" aria-label={`Permission needed: ${title}`} aria-describedby="perm-paused">
        <div className="dhead">
          <span className={`tile ${hidden ? "warn" : ""}`}><Icon name={hidden ? "warning" : KIND_ICON[p.kind] ?? "shield"} size={16} /></span>
          <div className="dtitles">
            <h2 id="perm-title">{title}</h2>
            <div id="perm-paused" className="dsub">{subtitle}</div>
          </div>
          {mode && <span className={`modebadge m-${mode}`}><Icon name={MODE_ICON[mode]} size={11} />{MODE_LABEL[mode]}</span>}
        </div>
        <div className="dbody">
          <pre className="action">{markHidden(p.display.join("\n"))}</pre>
          {hidden && (
            <div className="findings">
              <div className="ftitle">Hidden characters found</div>
              {p.hiddenExplanation && <div className="fbody">{p.hiddenExplanation}</div>}
              <ul>
                {p.findings.map((f, i) => (
                  <li key={i}>Hidden: {f}</li>
                ))}
              </ul>
            </div>
          )}
          {p.note && (
            <figure className="note">
              <Icon name="shield-judge" />
              <figcaption>{mode === "judge" && <strong>Judge: </strong>}{p.note}</figcaption>
            </figure>
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
        </div>
        <div className="dfoot">
          <span className="keyhint">Esc or Enter denies</span>
          <button ref={deny} id="perm-deny" className="btn deny" onClick={() => answer(false)}>Deny</button>
          <button className="btn btn-ghost allow" onClick={() => answer(true)}>Allow</button>
        </div>
      </div>
    </div>
  );
}
