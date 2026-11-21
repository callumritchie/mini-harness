import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";

const COMMANDS: { cmd: string; help: string }[] = [
  { cmd: "/new", help: "start a new session" },
  { cmd: "/goal", help: "work unattended until done" },
  { cmd: "/compact", help: "replace the conversation with a summary" },
  { cmd: "/context", help: "what fills the context window" },
  { cmd: "/model ", help: "switch model" },
  { cmd: "/permissions ", help: "ask | judge | allow" },
  { cmd: "/effort ", help: "low … max, or default" },
  { cmd: "/limit ", help: "compaction limit in tokens" },
  { cmd: "/help", help: "list commands" },
];

export function Composer() {
  const [text, setText] = useState("");
  const [pick, setPick] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = useStore((s) => s.running);
  const connected = useStore((s) => s.connected);
  const submit = useStore((s) => s.submit);
  const cancel = useStore((s) => s.cancel);
  const draft = useStore((s) => s.draft);
  const patch = useStore((s) => s.patch);
  const allow = useStore((s) => s.info?.permissions === "allow");
  const setMode = useStore((s) => s.setMode);

  useEffect(() => {
    if (draft === null) return;
    setText(draft);
    patch({ draft: null });
    ref.current?.focus();
  }, [draft, patch]);

  const matches = useMemo(() => (text.startsWith("/") && !text.includes("\n") ? COMMANDS.filter((c) => c.cmd.startsWith(text.split(" ")[0]) && text.split(" ").length === 1) : []), [text]);

  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 220) + "px";
    }
  }, [text]);
  useEffect(() => setPick(0), [matches.length]);

  const send = () => {
    if (!text.trim()) return;
    submit(text);
    setText("");
  };

  return (
    <div className="composer">
      {allow && (
        <div className="allow-strip" role="status">
          <span><b>Allow is on:</b> nothing is asked. Commands run as you.</span>
          <button onClick={() => setMode("ask")}>Switch to Ask</button>
        </div>
      )}
      {matches.length > 0 && (
        <ul className="palette" role="listbox">
          {matches.map((m, i) => (
            <li key={m.cmd} role="option" aria-selected={i === pick} className={i === pick ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); setText(m.cmd); ref.current?.focus(); }}>
              <code>{m.cmd.trim()}</code> <span>{m.help}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="box">
        <textarea
          ref={ref}
          id="composer"
          value={text}
          rows={1}
          placeholder={connected ? (running ? "Working… press Stop to interrupt" : "Message Mini Harness, or / for commands") : "Connecting…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setPick((p) => (p + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
            } else if (matches.length && e.key === "Tab") {
              e.preventDefault();
              setText(matches[pick].cmd);
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape" && running) {
              cancel();
            }
          }}
          autoFocus
        />
        {running ? (
          <button className="stop" onClick={cancel} aria-label="Stop">■ Stop</button>
        ) : (
          <button className="send" onClick={send} disabled={!text.trim() || !connected} aria-label="Send">↑</button>
        )}
      </div>
      <div className="foot"><kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <kbd>Esc</kbd> stop</div>
    </div>
  );
}
