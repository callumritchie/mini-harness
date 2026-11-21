import { useStore } from "../store";
import { Icon } from "./Icon";
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
  const project = info?.project.split("/").pop();
  const loaded = info
    ? [info.agents_md && "AGENTS.md loaded", info.skills.length > 0 && `${info.skills.length} skill${info.skills.length === 1 ? "" : "s"}`,
       info.mcp_tools.length > 0 && `${info.mcp_tools.length} MCP tool${info.mcp_tools.length === 1 ? "" : "s"}`].filter(Boolean)
    : [];
  return (
    <div className="welcome">
      <div>
        <Logo size={28} />
        <h1 title={info?.project}>{project ? <>What should we work on in {project}?</> : "What should we work on?"}</h1>
        <p className="where">
          {info ? <>Working with <b>{info.model}</b>.{loaded.length > 0 && <> {loaded.join(" · ")}.</>}</> : "Connecting…"}
          {demo && " This is the demo: a scripted model, nothing is real. Try “hello”, “create a file”, then “delete it”."}
        </p>
      </div>
      {info && !info.client_ready && (
        <div className="warnpanel alert" role="alert"><Icon name="warning" /><span>{info.client_error ?? "No API key yet."}</span></div>
      )}
      <div className="starters">
        {STARTERS.map((s) => (
          <button key={s.title} className="starter" onClick={() => patch({ draft: s.text })}>
            <b>{s.title}</b>
            <span>{s.text}</span>
          </button>
        ))}
      </div>
      <p className="keys">
        <span><kbd>/</kbd> commands</span><span><kbd>⌘K</kbd> message box</span><span><kbd>⌘B</kbd> sessions</span><span><kbd>Esc</kbd> stop</span>
        <span>Risky actions always ask first.</span>
      </p>
    </div>
  );
}
