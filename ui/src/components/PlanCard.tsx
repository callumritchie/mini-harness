import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

/** A plan waiting for approval (exit_plan_mode), inline in the chat: approve it, or say what to change and keep planning. */
export function PlanCard() {
  const plan = useStore((s) => s.plan);
  const answer = useStore((s) => s.answerPlan);
  const [revising, setRevising] = useState(false);
  const [text, setText] = useState("");
  const card = useRef<HTMLDivElement>(null);
  const had = useRef(false);
  const id = plan?.id;

  // a plan appearing takes focus (Approve); when it closes focus goes back to the message box
  useEffect(() => {
    setRevising(false);
    setText("");
    if (id) {
      had.current = true;
      card.current?.querySelector<HTMLElement>(".plan-approve")?.focus();
    } else if (had.current) {
      had.current = false;
      document.getElementById("composer")?.focus();
    }
  }, [id]);

  if (!plan) return null;
  return (
    <div className="agent-row">
      <span className="agent-mark" />
      <div className="agent-body">
        <div className="plan-card" role="group" aria-labelledby="plan-eyebrow" ref={card}>
          <div className="ask-eyebrow" id="plan-eyebrow"><Icon name="plan" /> The agent has a plan and is waiting for your approval</div>
          <div className="plan-body"><Markdown text={plan.plan} /></div>
          {revising ? (
            <form
              className="ask-form"
              onSubmit={(e) => {
                e.preventDefault();
                answer(false, text.trim());
              }}
            >
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What should change?" autoFocus aria-label="What should change in the plan" />
              <button type="submit" className="btn btn-primary btn-lg" disabled={!text.trim()}>Send</button>
              <button type="button" className="btn btn-ghost btn-lg" onClick={() => setRevising(false)}>Back</button>
            </form>
          ) : (
            <div className="plan-actions">
              <button className="btn btn-primary btn-lg plan-approve" onClick={() => answer(true)}><Icon name="check" /> Approve and start</button>
              <button className="btn btn-ghost btn-lg" onClick={() => setRevising(true)}>Keep planning…</button>
              <span className="plan-hint">Approving turns plan mode off; your permission mode still applies.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
