import { useEffect } from "react";
import { api, getToken } from "./api";
import { Chat } from "./components/Chat";
import { Composer } from "./components/Composer";
import { ConfirmAllow } from "./components/ConfirmAllow";
import { GoalDialog } from "./components/GoalDialog";
import { PermissionDialog } from "./components/PermissionDialog";
import { RightPanel } from "./components/RightPanel";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import type { ServerEvent, SessionRow, TranscriptItem } from "./protocol";
import { connect } from "./socket";
import { fromTranscript, useStore } from "./store";

async function refreshSessions() {
  try {
    useStore.getState().patch({ sessions: await api<SessionRow[]>("sessions") });
  } catch {
    /* the sidebar just stays as it was */
  }
}

export default function App() {
  const connected = useStore((s) => s.connected);
  const allow = useStore((s) => s.info?.permissions === "allow");
  const token = getToken();

  useEffect(() => {
    // small screens start with both side panels closed (they open as drawers)
    const { patch } = useStore.getState();
    if (window.innerWidth < 760) patch({ sidebarOpen: false, rightOpen: false });
    else if (window.innerWidth < 1100) patch({ rightOpen: false });
    const keys = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        const { running, newSession } = useStore.getState();
        if (!running) newSession();
      } else if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById("composer")?.focus();
      } else if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        patch({ sidebarOpen: !useStore.getState().sidebarOpen });
      }
    };
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, []);

  useEffect(() => {
    if (!token) return;
    const { apply, patch, setSocket } = useStore.getState();
    let firstHello = true;
    const socket = connect(
      token,
      (ev: ServerEvent) => {
        apply(ev);
        if (ev.type === "hello") {
          // a fresh page: draw the conversation so far from the server
          if (firstHello && useStore.getState().items.length === 0) {
            api<{ items: TranscriptItem[] }>(`session/${ev.info.session_id}`)
              .then((r) => patch({ items: fromTranscript(r.items) }))
              .catch(() => undefined);
          }
          firstHello = false;
          refreshSessions();
        } else if (ev.type === "done" || ev.type === "session_loaded") {
          refreshSessions();
        }
      },
      (up) => {
        if (!up) patch({ connected: false });
      },
    );
    setSocket(socket);
    return () => {
      setSocket(null);
      socket.close();
    };
  }, [token]);

  if (!token) {
    return (
      <div className="gate">
        <h1>Mini Harness</h1>
        <p>This page needs the private address the server printed in your terminal (it ends with <code>?token=…</code>).</p>
        <p className="muted">Run <code>python3 agent.py --ui</code> and open the link it shows.</p>
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <div className={allow ? "shell allow" : "shell"}>
        <main className="main">
          <TopBar />
          {!connected && <div className="banner" role="status"><span className="spinner" aria-hidden /> Disconnected from the server. Reconnecting…</div>}
          <Chat />
          <Composer />
        </main>
        <RightPanel />
      </div>
      <PermissionDialog />
      <ConfirmAllow />
      <GoalDialog />
    </div>
  );
}
