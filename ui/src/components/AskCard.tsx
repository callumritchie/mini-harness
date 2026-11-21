import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { Icon } from "./Icon";

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

/** The ask_user question, inline in the chat: numbered choices (keys 1–9 pick one), or your own answer. */
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

  // number keys pick a choice, but never while typing and never while an approval is open (that dialog has its own rules)
  useEffect(() => {
    if (!ask || ask.choices.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || useStore.getState().permission) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= ask.choices.length) {
        e.preventDefault();
        answer(ask.choices[n - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ask, answer]);

  if (!ask) return null;
  return (
    <div className="agent-row">
      <span className="agent-mark" />
      <div className="agent-body">
        <div className="ask" role="group" aria-labelledby="ask-eyebrow ask-q" ref={card}>
          <div className="ask-eyebrow" id="ask-eyebrow"><Icon name="bubble" /> The agent is waiting for your answer</div>
          <div className="ask-q" id="ask-q">{ask.question}</div>
          {ask.choices.length > 0 && (
            <ol className="choices">
              {ask.choices.map((c, i) => (
                <li key={i}>
                  <button onClick={() => answer(c)}>
                    {i < 9 && <kbd className="num">{i + 1}</kbd>}{c}
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
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={ask.choices.length ? "Or type your own answer" : "Your answer"} autoFocus={ask.choices.length === 0} />
            <button type="submit" className="btn btn-primary btn-lg" disabled={!text.trim()}>Answer</button>
            <button type="button" className="btn btn-ghost btn-lg" onClick={() => answer(null)}>Skip</button>
          </form>
        </div>
      </div>
    </div>
  );
}
