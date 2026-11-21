import { useStore } from "../store";
import { Logo } from "./Logo";

const STARTERS = [
  { title: "Explore this project", text: "Look around this project and tell me what it does and how it is organised." },
  { title: "Find and fix a bug", text: "Run the tests, and if any fail, find the cause and fix it." },
  { title: "Add a feature", text: "I want to add a feature. Ask me what it should do, then plan it before changing anything." },
  { title: "Review recent changes", text: "Review my uncommitted changes and point out anything risky or unclear." },
];

/** The empty chat: where we are, a few ways to begin (they fill the message box; nothing is sent), and the shortcuts. */
export function Welcome() {
  const info = useStore((s) => s.info);
  const demo = useStore((s) => s.demo);
  const patch = useStore((s) => s.patch);
  return (
    <div className="welcome">
      <Logo size={36} />
      {info && <div className="where-title" title={info.project}>{info.project.split("/").pop()}</div>}
      <h1>What should we work on?</h1>
      <p className="where">
        {info ? <>Working in <code title={info.project}>{info.project.split("/").pop()}</code> with <b>{info.model}</b>.</> : "Connecting…"}
        {demo && " This is the demo: a scripted model, nothing is real. Try “hello”, “create a file”, then “delete it”."}
      </p>
      {info && !info.client_ready && <div className="warnpanel" role="alert">{info.client_error ?? "No API key yet."}</div>}
      <div className="starters">
        {STARTERS.map((s) => (
          <button key={s.title} className="starter" onClick={() => patch({ draft: s.text })}>
            <b>{s.title}</b>
            <span>{s.text}</span>
          </button>
        ))}
      </div>
      <p className="keys">
        <kbd>/</kbd> commands · <kbd>⌘K</kbd> message box · <kbd>⌘B</kbd> sessions · <kbd>Esc</kbd> stop. Risky actions always ask first.
      </p>
    </div>
  );
}
