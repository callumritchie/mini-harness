import { useState } from "react";
import { useStore } from "../store";
import { Icon } from "./Icon";

export function GoalDialog() {
  const show = useStore((s) => s.showGoal);
  const patch = useStore((s) => s.patch);
  const goal = useStore((s) => s.goal);
  const mode = useStore((s) => s.info?.permissions);
  const [text, setText] = useState("");
  const [verify, setVerify] = useState("");
  const [turns, setTurns] = useState("");
  if (!show) return null;
  return (
    <div className="overlay">
      <form
        className="dialog goal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-title"
        onSubmit={(e) => {
          e.preventDefault();
          goal(text.trim(), verify.trim() || undefined, turns ? Number(turns) : undefined);
        }}
      >
        <div className="dbody roomy">
          <div>
            <h2 id="goal-title">Work unattended on a goal</h2>
            <p className="dsub">
              It keeps working until it claims it is done with evidence; then your check runs; then a fresh read-only reviewer checks the work.
              It cannot ask you questions.
            </p>
          </div>
          <label>Goal<textarea className="field" value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus required /></label>
          <div className="goal-row">
            <label>Your check <span className="opt">optional</span><input className="field mono" value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="python3 -m unittest -q" /></label>
            <label>Turn limit <span className="opt">optional</span><input className="field mono" inputMode="numeric" value={turns} onChange={(e) => setTurns(e.target.value.replace(/\D/g, ""))} placeholder="100" /></label>
          </div>
          {mode === "ask" && (
            <div className="warnpanel alert" role="note">
              <Icon name="shield" />
              <span>In Ask mode, risky steps still wait for you, so it will not run hands-off. Switch to Judge, or use --allow rules.</span>
            </div>
          )}
        </div>
        <div className="dfoot">
          <span className="spacer" />
          <button type="button" className="btn btn-ghost" onClick={() => patch({ showGoal: false })}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!text.trim()}>Start goal</button>
        </div>
      </form>
    </div>
  );
}
