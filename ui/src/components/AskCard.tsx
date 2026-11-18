import { useState } from "react";
import { useStore } from "../store";

/** The ask_user question, inline in the chat: numbered choices, or your own answer. */
export function AskCard() {
  const ask = useStore((s) => s.ask);
  const answer = useStore((s) => s.answerAsk);
  const [text, setText] = useState("");
  if (!ask) return null;
  return (
    <div className="ask" role="group" aria-label="Question from the agent">
      <div className="ask-q">{ask.question}</div>
      {ask.choices.length > 0 && (
        <ol className="choices">
          {ask.choices.map((c, i) => (
            <li key={i}>
              <button onClick={() => answer(c)}>
                <span className="num">{i + 1}</span> {c}
              </button>
            </li>
          ))}
        </ol>
      )}
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          answer(text.trim());
          setText("");
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={ask.choices.length ? "…or type your own answer" : "Your answer"} autoFocus={ask.choices.length === 0} />
        <button type="submit" disabled={!text.trim()}>Send</button>
        <button type="button" className="ghost" onClick={() => answer(null)}>Skip</button>
      </form>
    </div>
  );
}
