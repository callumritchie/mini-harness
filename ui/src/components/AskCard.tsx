import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";

/** The ask_user question, inline in the chat: numbered choices, or your own answer. */
export function AskCard() {
  const ask = useStore((s) => s.ask);
  const answer = useStore((s) => s.answerAsk);
  const [text, setText] = useState("");
  const card = useRef<HTMLDivElement>(null);
  const had = useRef(false);
  const id = ask?.id;

  // a question appearing takes focus (first choice, or the text field); when it closes focus goes back to the message box
  useEffect(() => {
    if (id) {
      had.current = true;
      card.current?.querySelector<HTMLElement>(".choices button, .ask-form input")?.focus();
    } else if (had.current) {
      had.current = false;
      document.getElementById("composer")?.focus();
    }
  }, [id]);

  if (!ask) return null;
  return (
    <div className="agent-row">
    <span className="agent-mark" />
    <div className="agent-body">
    <div className="ask" role="group" aria-labelledby="ask-eyebrow ask-q" ref={card}>
      <div className="eyebrow" id="ask-eyebrow">The agent is waiting for your answer</div>
      <div className="ask-q" id="ask-q">{ask.question}</div>
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
    </div>
    </div>
  );
}
