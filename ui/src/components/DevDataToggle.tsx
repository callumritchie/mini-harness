import { useState } from "react";
import { useStore } from "../store";

/** Dev-only (Vite dev server + --demo): swap the demo model's data for the break-ui review. Each choice starts a new session and
 *  sends the demo model the prompt that produces that dataset (see demo.py); the choice is kept in the URL (?data=). Never ships. */
const STATES = [
  { id: "demo", label: "Demo data", prompt: "edit" },
  { id: "worst", label: "Worst case", prompt: "worst case: migrate every customer record under src/integrations/northwind-industries-holdings to the 2027 schema and tell Aleksandra Wiśniewska-Kowalczyk when it's done" },
  { id: "one", label: "One", prompt: "one" },
  { id: "empty", label: "Empty", prompt: null },
] as const;

function current() {
  return new URLSearchParams(window.location.search).get("data") ?? "demo";
}

export function DevDataToggle() {
  const demo = useStore((s) => s.demo);
  const running = useStore((s) => s.running);
  const [active, setActive] = useState(current);
  if (!import.meta.env.DEV || !demo) return null;

  const pick = (id: string, prompt: string | null) => {
    const url = new URL(window.location.href);
    url.searchParams.set("data", id);
    window.history.replaceState(null, "", url);
    setActive(id);
    const { newSession, submit, info } = useStore.getState();
    newSession();
    if (!prompt) return;
    // session_loaded replaces the chat items, so send only after it lands (it brings a fresh info object)
    const stop = useStore.subscribe((s) => {
      if (s.info === info) return;
      stop();
      submit(prompt);
    });
  };

  return (
    <div role="group" aria-label="Dev data" style={{ position: "fixed", left: "50%", bottom: 6, transform: "translateX(-50%)", zIndex: 100,
      display: "flex", gap: 2, padding: 2, background: "#d4d4d8", borderRadius: 8, font: "500 11px system-ui, sans-serif" }}>
      {STATES.map((s) => (
        <button key={s.id} disabled={running} onClick={() => pick(s.id, s.prompt)} aria-pressed={active === s.id}
          style={{ border: 0, borderRadius: 6, padding: "3px 9px", whiteSpace: "nowrap", cursor: running ? "default" : "pointer", font: "inherit",
            background: active === s.id ? "#fff" : "transparent", color: "#18181b", opacity: running ? 0.5 : 1 }}>
          {s.label}
        </button>
      ))}
    </div>
  );
}
