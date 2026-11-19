import { create } from "zustand";
import type { ClientRequest, CostSummary, Info, Mode, ServerEvent, SessionRow, TranscriptItem, Usage } from "./protocol";
import type { Socket } from "./socket";

export type Item =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      display: string;
      input: Record<string, unknown>;
      result: string | null;
      isError: boolean;
      status: "running" | "done";
    }
  | { kind: "notice"; id: string; text: string }
  | { kind: "summary"; id: string; text: string }
  | { kind: "error"; id: string; text: string };

export interface PermissionRequest {
  id: string;
  title: string;
  display: string[];
  findings: string[];
  reasons: string[];
  note: string | null;
  kind: string;
}

export interface AskRequest {
  id: string;
  question: string;
  choices: string[];
}

export type RightTab = "files" | "changes" | "context";

export interface ChatState {
  connected: boolean;
  demo: boolean;
  info: Info | null;
  items: Item[];
  running: boolean;
  lastUsage: Usage | null;
  totalCost: CostSummary | null;
  permission: PermissionRequest | null;
  ask: AskRequest | null;
  changes: Record<string, { before: string | null; after: string | null }>;
  sessions: SessionRow[];
  rightTab: RightTab;
  rightOpen: boolean;
  sidebarOpen: boolean;
  selectedChange: string | null;
  selectedFile: string | null;
  showGoal: boolean;
  draft: string | null; // text a starter button wants put in the message box
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}${++counter}`;

export const initialState: ChatState = {
  connected: false,
  demo: false,
  info: null,
  items: [],
  running: false,
  lastUsage: null,
  totalCost: null,
  permission: null,
  ask: null,
  changes: {},
  sessions: [],
  rightTab: "files",
  rightOpen: true,
  sidebarOpen: true,
  selectedChange: null,
  selectedFile: null,
  showGoal: false,
  draft: null,
};

/** One line describing a tool call, like the terminal's activity line. */
export function describeCall(name: string, input: Record<string, unknown>): string {
  const pick = ["command", "path", "pattern", "query", "question", "task"].map((k) => input[k]).find((v) => typeof v === "string") as
    | string
    | undefined;
  const detail = pick ?? (Object.keys(input).length ? JSON.stringify(input) : "");
  const short = detail.length > 120 ? detail.slice(0, 120) + "…" : detail;
  return `${name}(${short})`;
}

function finishStreaming(items: Item[]): Item[] {
  return items.map((i) => (i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i));
}

export function fromTranscript(items: TranscriptItem[]): Item[] {
  return items.map((t): Item => {
    switch (t.kind) {
      case "user":
        return { kind: "user", id: nextId("u"), text: t.text };
      case "assistant":
        return { kind: "assistant", id: nextId("a"), text: t.text, streaming: false };
      case "summary":
        return { kind: "summary", id: nextId("s"), text: t.text };
      case "tool":
        return {
          kind: "tool",
          id: t.id,
          name: t.name,
          display: describeCall(t.name, t.input),
          input: t.input,
          result: t.result,
          isError: t.is_error,
          status: "done",
        };
    }
  });
}

/** How the screen changes when the server says something. Pure, so it can be tested without a browser. */
export function reduce(s: ChatState, ev: ServerEvent): ChatState {
  switch (ev.type) {
    case "hello":
      return { ...s, connected: true, demo: ev.demo, info: ev.info, running: ev.running, totalCost: ev.info.cost };
    case "info":
      return { ...s, info: ev.info, totalCost: ev.info.cost };
    case "status":
      return { ...s, running: ev.running };
    case "text_delta": {
      const last = s.items[s.items.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        return { ...s, items: [...s.items.slice(0, -1), { ...last, text: last.text + ev.text }] };
      }
      return { ...s, items: [...s.items, { kind: "assistant", id: nextId("a"), text: ev.text, streaming: true }] };
    }
    case "tool_call": {
      if (s.items.some((i) => i.kind === "tool" && i.id === ev.id)) return s;
      return {
        ...s,
        items: [
          ...finishStreaming(s.items),
          { kind: "tool", id: ev.id, name: ev.name, display: ev.display, input: ev.input, result: null, isError: false, status: "running" },
        ],
      };
    }
    case "tool_result":
      return {
        ...s,
        items: s.items.map((i) => (i.kind === "tool" && i.id === ev.id ? { ...i, result: ev.text, isError: ev.is_error, status: "done" } : i)),
      };
    case "usage":
      return { ...s, lastUsage: ev.usage, totalCost: ev.total };
    case "notice":
      return { ...s, items: [...s.items, { kind: "notice", id: nextId("n"), text: ev.text }] };
    case "file_change": {
      const existing = s.changes[ev.path];
      return {
        ...s,
        changes: { ...s.changes, [ev.path]: { before: existing ? existing.before : ev.before, after: ev.after } },
        selectedChange: ev.path,
      };
    }
    case "permission_request":
      return { ...s, permission: { id: ev.id, title: ev.title, display: ev.display, findings: ev.findings, reasons: ev.reasons, note: ev.note, kind: ev.kind } };
    case "ask_user":
      return { ...s, ask: { id: ev.id, question: ev.question, choices: ev.choices } };
    case "question_closed":
      return {
        ...s,
        permission: s.permission?.id === ev.id ? null : s.permission,
        ask: s.ask?.id === ev.id ? null : s.ask,
      };
    case "done": {
      let items: Item[] = finishStreaming(s.items).map((i) => (i.kind === "tool" && i.status === "running" ? { ...i, status: "done" } : i));
      const note = (text: string): Item => ({ kind: "notice", id: nextId("n"), text });
      if (ev.error) items = [...items, { kind: "error", id: nextId("e"), text: ev.error }];
      else if (ev.interrupted) items = [...items, note("Stopped. That turn was dropped from the conversation.")];
      else if (ev.text.startsWith("GOAL")) items = [...items, { kind: "assistant", id: nextId("a"), text: ev.text, streaming: false }];
      else if (ev.stopped) items = [...items, note(`Not finished: ${ev.stopped}`)];
      else if (ev.cut_off) items = [...items, note("The reply was cut off at the maximum length.")];
      return { ...s, items, running: false, info: ev.info, totalCost: ev.info.cost, permission: null, ask: null };
    }
    case "session_loaded":
      return {
        ...s,
        items: fromTranscript(ev.items),
        info: ev.info,
        totalCost: ev.info.cost,
        changes: {},
        selectedChange: null,
        lastUsage: null,
        permission: null,
        ask: null,
        running: false,
      };
    case "error":
      return { ...s, items: [...s.items, { kind: "error", id: nextId("e"), text: ev.message }] };
  }
}

// ---------- actions ----------

export const SLASH_HELP = [
  "/new — start a new session",
  "/resume [id] — continue a session (or pick one in the sidebar)",
  "/model NAME — switch model",
  "/permissions ask|judge|allow",
  "/effort low|medium|high|xhigh|max|default",
  "/limit TOKENS — where automatic compaction starts",
  "/compact [focus] — replace the conversation with a summary",
  "/goal — work unattended until done (opens a form)",
  "/context — show what fills the context window",
];

interface Actions {
  apply(ev: ServerEvent): void;
  setSocket(socket: Socket | null): void;
  submit(text: string): void;
  cancel(): void;
  answerPermission(allow: boolean): void;
  answerAsk(answer: string | null): void;
  setModel(model: string): void;
  setMode(mode: Mode): void;
  setEffort(effort: string | null): void;
  setLimit(limit: number): void;
  newSession(): void;
  resume(id: string): void;
  compact(focus?: string): void;
  goal(text: string, verify?: string, maxTurns?: number): void;
  patch(partial: Partial<ChatState>): void;
}

let socket: Socket | null = null;

export const useStore = create<ChatState & Actions>((set, get) => {
  const request = (r: ClientRequest) => {
    if (!socket || !socket.send(r)) {
      set((s) => ({ items: [...s.items, { kind: "error", id: nextId("e"), text: "Not connected to the server. Reconnecting…" }] }));
      return false;
    }
    return true;
  };
  const notice = (text: string) => set((s) => ({ items: [...s.items, { kind: "notice", id: nextId("n"), text }] }));

  return {
    ...initialState,
    apply: (ev) => set((s) => reduce(s, ev)),
    setSocket: (sock) => {
      socket = sock;
    },
    patch: (partial) => set(partial),
    submit(raw) {
      const text = raw.trim();
      if (!text) return;
      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.split(/\s+/);
        const arg = rest.join(" ");
        switch (cmd) {
          case "/new":
          case "/clear":
            return get().newSession();
          case "/resume":
            return arg ? get().resume(arg) : notice("Pick a session in the sidebar, or use /resume ID.");
          case "/model":
            return arg ? get().setModel(arg) : notice(`Current model: ${get().info?.model}`);
          case "/permissions":
            return ["ask", "judge", "allow"].includes(arg) ? get().setMode(arg as Mode) : notice(`Permissions: ${get().info?.permissions}. Use /permissions ask|judge|allow.`);
          case "/effort":
            return get().setEffort(arg === "default" || !arg ? null : arg);
          case "/limit":
            return /^\d+$/.test(arg) ? get().setLimit(Number(arg)) : notice(`Compaction limit: ${get().info?.limit.toLocaleString()} tokens. Use /limit TOKENS.`);
          case "/compact":
            return get().compact(arg || undefined);
          case "/goal":
            return set({ showGoal: true });
          case "/context":
            return set({ rightTab: "context", rightOpen: true });
          case "/help":
            return notice(SLASH_HELP.join("\n"));
          default:
            return set((s) => ({ items: [...s.items, { kind: "error", id: nextId("e"), text: `Unknown command ${cmd}. Try /help.` }] }));
        }
      }
      if (get().running) return;
      if (request({ type: "send", text })) {
        set((s) => ({ items: [...finishStreaming(s.items), { kind: "user", id: nextId("u"), text }] }));
      }
    },
    cancel: () => void request({ type: "cancel" }),
    answerPermission(allow) {
      const p = get().permission;
      if (p && request({ type: "answer_permission", id: p.id, allow })) set({ permission: null });
    },
    answerAsk(answer) {
      const a = get().ask;
      if (a && request({ type: "answer_ask", id: a.id, answer })) set({ ask: null });
    },
    setModel: (model) => void request({ type: "set_model", model }),
    setMode: (mode) => void request({ type: "set_permissions", mode }),
    setEffort: (effort) => void request({ type: "set_effort", effort }),
    setLimit: (limit) => void request({ type: "set_limit", limit }),
    newSession: () => void request({ type: "new_session" }),
    resume: (id) => void request({ type: "resume", ref: id }),
    compact: (focus) => void request({ type: "compact", focus }),
    goal(text, verify, maxTurns) {
      if (request({ type: "goal", text, verify, max_turns: maxTurns })) {
        set((s) => ({ items: [...s.items, { kind: "user", id: nextId("u"), text: `/goal ${text}${verify ? `  (check: ${verify})` : ""}` }], showGoal: false }));
      }
    },
  };
});
