import { useState } from "react";
import { useStore } from "../store";

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
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="goal-title"
        onSubmit={(e) => {
          e.preventDefault();
          goal(text.trim(), verify.trim() || undefined, turns ? Number(turns) : undefined);
        }}
      >
        <h2 id="goal-title">Work unattended on a goal</h2>
        <p className="hint">
          It keeps working until it claims it is done with evidence; then your check runs; then a fresh read-only reviewer checks the work.
          It cannot ask you questions{mode === "ask" ? ", and in “ask” mode risky steps still wait for you. Switch to “judge” or use --allow rules to run hands-off" : ""}.
        </p>
        <label>Goal<textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} autoFocus required /></label>
        <label>Your check (optional)<input value={verify} onChange={(e) => setVerify(e.target.value)} placeholder="python3 -m unittest -q" /></label>
        <label>Turn limit (optional)<input value={turns} onChange={(e) => setTurns(e.target.value.replace(/\D/g, ""))} placeholder="100" /></label>
        <div className="buttons">
          <button type="button" className="ghost" onClick={() => patch({ showGoal: false })}>Cancel</button>
          <button type="submit" className="allow" disabled={!text.trim()}>Start</button>
        </div>
      </form>
    </div>
  );
}
