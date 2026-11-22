import { create } from "zustand";
import type { Approval, AttachmentRef, ClientRequest, CostSummary, Info, Mode, ServerEvent, SessionRow, TranscriptItem, Uploaded, Usage } from "./protocol";
import type { RoundLine } from "./lib/goal";
import type { Socket } from "./socket";

/** What the page remembers about a goal it started: enough to run it again and to say what it cost. */
export interface GoalRun {
  text: string;
  verify?: string;
  maxTurns?: number;
  costAtStart: number | null;
}
/** A goal as it runs, built from the server's goal events. */
export interface GoalLive {
  text: string;
  verify: string | null;
  maxTurns: number | null;
  round: number;
  lines: RoundLine[];
}

export interface GoalResult extends Omit<GoalRun, "costAtStart"> {
  lines?: RoundLine[]; // every step of the run, for "Show all rounds"
  cost: number | null; // what this goal added to the session total, when both ends are known
  complete: boolean;
}

/** A file shown on a sent message: a thumbnail only for images sent from this page (a reloaded session has names only). */
export type SentFile = AttachmentRef & { preview?: string };
/** A file in the message box: uploading, uploaded (it has the server's id), or refused (the reason). */
export interface PendingFile {
  key: string;
  name: string;
  size: number;
  kind?: Uploaded["kind"];
  preview?: string;
  id?: string;
  error?: string;
}

export type Item =
  | { kind: "user"; id: string; text: string; attachments?: SentFile[] }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; goal?: GoalResult }
  | { kind: "thinking"; id: string; text: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      display: string;
      input: Record<string, unknown>;
      result: string | null;
      isError: boolean;
      status: "running" | "done";
      /** set when this failed call was a denial: who said no (the row then says so instead of showing the model-facing text) */
      denied?: "user" | "judge" | "rule";
      approval?: Approval | null; // who decided, when the server says so
      outcome?: string | null; // the server's few words on how it went
      mcp?: boolean;
      group?: string | null; // calls from one reply that ran at the same time share this
      index?: number | null; // a parallel subagent's number ([1]..[4])
      steps?: string[]; // what a subagent did, step by step
      change?: { before: string | null; after: string | null }; // what this call did to its file (the Changes tab shows the whole session)
      finish?: { calls: number; cost: number | null };
    }
  | { kind: "notice"; id: string; text: string; tone?: "stopped" | "unfinished" | "cutoff" }
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
  toolId?: string | null;
  hiddenExplanation?: string | null;
}

export interface AskRequest {
  id: string;
  question: string;
  choices: string[];
}

export interface PlanRequest {
  id: string;
  plan: string;
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
  plan: PlanRequest | null; // a plan waiting for approval (exit_plan_mode)
  changes: Record<string, { before: string | null; after: string | null }>;
  sessions: SessionRow[];
  rightTab: RightTab;
  rightOpen: boolean;
  sidebarOpen: boolean;
  selectedChange: string | null;
  selectedFile: string | null;
  showGoal: boolean;
  confirmAllow: boolean;
  wrap: boolean; // wrap long lines in diffs and the file viewer (remembered in this browser)
  /** a denial whose tool result has not arrived yet; until the server sends tool ids, the next error result is taken to be that call */
  denial: "user" | "judge" | null;
  draft: string | null; // text a starter button wants put in the message box
  goalRun: GoalRun | null; // the goal started from this page, until its result arrives
  goalLive: GoalLive | null; // the running goal's steps, from the server's goal events
}

const WRAP_KEY = "mini-harness-wrap";
function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) !== "0";
  } catch {
    return true;
  }
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
  plan: null,
  changes: {},
  sessions: [],
  rightTab: "files",
  rightOpen: true,
  sidebarOpen: true,
  selectedChange: null,
  selectedFile: null,
  showGoal: false,
  confirmAllow: false,
  wrap: true,
  denial: null,
  draft: null,
  goalRun: null,
  goalLive: null,
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
  return items.map((i) => ((i.kind === "assistant" || i.kind === "thinking") && i.streaming ? { ...i, streaming: false } : i));
}

export function fromTranscript(items: TranscriptItem[]): Item[] {
  return items.map((t): Item => {
    switch (t.kind) {
      case "user":
        return { kind: "user", id: nextId("u"), text: t.text, ...(t.attachments?.length ? { attachments: t.attachments } : {}) };
      case "assistant":
        return { kind: "assistant", id: nextId("a"), text: t.text, streaming: false };
      case "thinking":
        return { kind: "thinking", id: nextId("t"), text: t.text, streaming: false };
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
          outcome: t.outcome ?? null,
        };
    }
  });
}

let lineId = 0;
type GoalEvent = Extract<ServerEvent, { type: "goal_round" | "goal_status" | "check_result" | "reviewer_verdict" }>;
const STATUS: Record<"no_claim" | "no_evidence" | "claimed" | "reviewing", [RoundLine["marker"], string]> = {
  no_claim: ["dot", "No claim of done yet; asked it to carry on"],
  no_evidence: ["bad", "Claimed done without evidence; sent back"],
  claimed: ["ok", "Claims it is done"],
  reviewing: ["dot", "A fresh read-only reviewer is checking the work…"],
};

/** One line of the goal card for one goal event. */
export function goalLine(ev: GoalEvent): RoundLine {
  const id = `g${++lineId}`;
  switch (ev.type) {
    case "goal_round":
      return { id, marker: ev.n, text: `Round ${ev.n}: working…` };
    case "goal_status":
      return { id, marker: STATUS[ev.status][0], text: STATUS[ev.status][1] };
    case "check_result":
      return { id, marker: ev.passed ? "ok" : "bad", text: ev.passed ? `Check ${ev.cmd} passed` : `Check ${ev.cmd} failed (exit ${ev.exit_code})` };
    case "reviewer_verdict":
      return { id, marker: ev.verdict ? "ok" : ev.verdict === false ? "bad" : "dot", text: `Reviewer: ${ev.verdict ? "done" : ev.verdict === false ? "not done" : "unclear"}` };
  }
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
    case "text_delta":
    case "thinking_delta": {
      const kind = ev.type === "text_delta" ? "assistant" : "thinking";
      const last = s.items[s.items.length - 1];
      if (last && last.kind === kind && last.streaming) {
        return { ...s, items: [...s.items.slice(0, -1), { ...last, text: last.text + ev.text }] };
      }
      // a new piece of reasoning or reply: whatever was streaming before it is finished
      return { ...s, items: [...finishStreaming(s.items), { kind, id: nextId(kind === "assistant" ? "a" : "t"), text: ev.text, streaming: true }] };
    }
    case "plan_request":
      return { ...s, plan: { id: ev.id, plan: ev.plan } };
    case "plan_mode":
      return s.info ? { ...s, info: { ...s.info, plan: ev.on } } : s;
    case "tool_call": {
      if (s.items.some((i) => i.kind === "tool" && i.id === ev.id)) return s;
      return {
        ...s,
        items: [
          ...finishStreaming(s.items),
          { kind: "tool", id: ev.id, name: ev.name, display: ev.display, input: ev.input, result: null, isError: false, status: "running", group: ev.parallel_group ?? null },
        ],
      };
    }
    case "tool_result": {
      // a server that says who decided is exact; an older one leaves us the guess: the next error after a denial is that call
      const exact = ev.approval !== undefined;
      const denied = exact ? (ev.approval && !ev.approval.allowed ? ev.approval.by : null) : ev.is_error ? s.denial : null;
      const extra = { approval: ev.approval ?? null, outcome: ev.outcome ?? null, mcp: ev.mcp ?? false };
      return {
        ...s,
        denial: exact || ev.is_error ? null : s.denial,
        items: s.items.map((i) => (i.kind === "tool" && i.id === ev.id ? { ...i, ...extra, result: ev.text, isError: ev.is_error, status: "done", ...(denied ? { denied } : {}) } : i)),
      };
    }
    case "subagent_step":
    case "subagent_finish":
      return {
        ...s,
        items: s.items.map((i) => {
          if (i.kind !== "tool" || i.id !== ev.parent_id) return i;
          return ev.type === "subagent_step"
            ? { ...i, index: ev.index, steps: [...(i.steps ?? []), ev.display] }
            : { ...i, index: ev.index, finish: { calls: ev.calls, cost: ev.cost } };
        }),
      };
    case "goal_start":
      return { ...s, goalLive: { text: ev.text, verify: ev.verify, maxTurns: ev.max_turns, round: 0, lines: [] } };
    case "goal_round":
    case "goal_status":
    case "check_result":
    case "reviewer_verdict": {
      const g = s.goalLive ?? { text: "", verify: null, maxTurns: null, round: 0, lines: [] };
      return { ...s, goalLive: { ...g, round: ev.type === "goal_round" ? ev.n : g.round, lines: [...g.lines, goalLine(ev)] } };
    }
    case "usage":
      return { ...s, lastUsage: ev.usage, totalCost: ev.total };
    case "notice":
      return { ...s, denial: /^\s*judge: deny/.test(ev.text) ? "judge" : s.denial, items: [...s.items, { kind: "notice", id: nextId("n"), text: ev.text }] };
    case "file_change": {
      const existing = s.changes[ev.path];
      // the write or edit that made this change is the latest one still running on that path (the server sends it mid-call)
      let owner = -1;
      for (let i = s.items.length - 1; i >= 0; i--) {
        const it = s.items[i];
        if (it.kind === "tool" && it.status === "running" && (it.name === "write_file" || it.name === "edit_file") && it.input.path === ev.path) {
          owner = i;
          break;
        }
      }
      return {
        ...s,
        changes: { ...s.changes, [ev.path]: { before: existing ? existing.before : ev.before, after: ev.after } },
        selectedChange: ev.path,
        items: owner < 0 ? s.items : s.items.map((it, i) => (i === owner ? { ...it, change: { before: ev.before, after: ev.after } } : it)),
      };
    }
    case "permission_request":
      return {
        ...s,
        permission: { id: ev.id, title: ev.title, display: ev.display, findings: ev.findings, reasons: ev.reasons, note: ev.note, kind: ev.kind,
                      toolId: ev.tool_id ?? null, hiddenExplanation: ev.hidden_explanation ?? null },
      };
    case "ask_user":
      return { ...s, ask: { id: ev.id, question: ev.question, choices: ev.choices } };
    case "question_closed":
      return {
        ...s,
        permission: s.permission?.id === ev.id ? null : s.permission,
        ask: s.ask?.id === ev.id ? null : s.ask,
        plan: s.plan?.id === ev.id ? null : s.plan,
      };
    case "done": {
      let items: Item[] = finishStreaming(s.items).map((i) => (i.kind === "tool" && i.status === "running" ? { ...i, status: "done" } : i));
      const note = (text: string, tone?: "stopped" | "unfinished" | "cutoff"): Item => ({ kind: "notice", id: nextId("n"), text, tone });
      if (ev.error) items = [...items, { kind: "error", id: nextId("e"), text: ev.error }];
      else if (ev.interrupted) items = [...items, note("Stopped. That turn was dropped from the conversation.", "stopped")];
      else if (ev.text.startsWith("GOAL")) {
        const live = s.goalLive;
        const run = s.goalRun ?? (live ? { text: live.text, verify: live.verify ?? undefined, maxTurns: live.maxTurns ?? undefined, costAtStart: null } : null);
        const end = ev.info.cost.usd;
        const goal: GoalResult | undefined = run ? {
          text: run.text, verify: run.verify, maxTurns: run.maxTurns, lines: s.goalLive?.lines,
          cost: run.costAtStart !== null && end !== null ? Math.max(0, end - run.costAtStart) : null, complete: ev.info.cost.complete,
        } : undefined;
        items = [...items, { kind: "assistant", id: nextId("a"), text: ev.text, streaming: false, ...(goal ? { goal } : {}) }];
      }
      else if (ev.stopped) items = [...items, note(`Not finished: ${ev.stopped}`, "unfinished")];
      else if (ev.cut_off) items = [...items, note("Cut off. The reply hit its maximum length.", "cutoff")];
      return { ...s, items, running: false, info: ev.info, totalCost: ev.info.cost, permission: null, ask: null, plan: null, denial: null, goalRun: null, goalLive: null };
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
        plan: null,
        denial: null,
        goalLive: null,
        running: false,
      };
    case "error":
      return { ...s, items: [...s.items, { kind: "error", id: nextId("e"), text: ev.message }] };
  }
}

// ---------- actions ----------

export const SLASH_HELP = [
  "/new — start a new session",
  "/clear — clear the conversation and start fresh (the old one stays under Sessions)",
  "/plan [on|off] — plan mode: read-only until you approve a plan (Shift+Tab switches it)",
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
  /** Send a message (or run a slash command). Returns false when nothing was sent, so the message box keeps its text. */
  submit(text: string, files?: (Uploaded & { preview?: string })[]): boolean;
  cancel(): void;
  answerPermission(allow: boolean): void;
  answerAsk(answer: string | null): void;
  answerPlan(approve: boolean, feedback?: string): void;
  setPlan(on: boolean): void;
  command(cmd: string, arg: string): void;
  setModel(model: string): void;
  setMode(mode: Mode): void;
  confirmAllowMode(): void;
  setEffort(effort: string | null): void;
  setLimit(limit: number): void;
  newSession(): void;
  resume(id: string): void;
  compact(focus?: string): void;
  goal(text: string, verify?: string, maxTurns?: number): void;
  patch(partial: Partial<ChatState>): void;
  toggleWrap(): void;
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
    wrap: readWrap(),
    apply: (ev) => set((s) => reduce(s, ev)),
    setSocket: (sock) => {
      socket = sock;
    },
    patch: (partial) => set(partial),
    toggleWrap() {
      const wrap = !get().wrap;
      set({ wrap });
      try {
        localStorage.setItem(WRAP_KEY, wrap ? "1" : "0");
      } catch {
        /* not remembered */
      }
    },
    submit(raw, files = []) {
      const text = raw.trim();
      if (!text && !files.length) return false;
      if (text.startsWith("/") && !files.length) {
        const [cmd, ...rest] = text.split(/\s+/);
        const arg = rest.join(" ");
        const run = (fn: () => void) => (fn(), true);
        switch (cmd) {
          case "/new":
          case "/clear":
            return run(get().newSession);
          case "/plan":
            if (arg && arg !== "on" && arg !== "off") return run(() => notice("Use /plan, /plan on or /plan off."));
            return run(() => get().setPlan(arg ? arg === "on" : !get().info?.plan));
          default:
            return run(() => get().command(cmd, arg));
        }
      }
      if (get().running) return false;
      const ids = files.map((f) => f.id);
      if (request({ type: "send", text, ...(ids.length ? { attachments: ids } : {}) })) {
        const sent: SentFile[] = files.map((f) => ({ name: f.name, kind: f.kind, ...(f.preview ? { preview: f.preview } : {}) }));
        set((s) => ({ items: [...finishStreaming(s.items), { kind: "user", id: nextId("u"), text, ...(sent.length ? { attachments: sent } : {}) }] }));
        return true;
      }
      return false;
    },
    command(cmd, arg) {
      switch (cmd) {
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
    },
    cancel: () => void request({ type: "cancel" }),
    answerPlan(approve, feedback) {
      const p = get().plan;
      if (p && request({ type: "answer_plan", id: p.id, approve, ...(feedback ? { feedback } : {}) })) set({ plan: null });
    },
    setPlan: (on) => void request({ type: "set_plan", on }),
    answerPermission(allow) {
      const p = get().permission;
      if (p && request({ type: "answer_permission", id: p.id, allow })) set({ permission: null, ...(allow ? {} : { denial: "user" as const }) });
    },
    answerAsk(answer) {
      const a = get().ask;
      if (a && request({ type: "answer_ask", id: a.id, answer })) set({ ask: null });
    },
    setModel: (model) => void request({ type: "set_model", model }),
    setMode(mode) {
      // Allow is never one step: the first request only opens the confirmation
      if (mode === "allow" && get().info?.permissions !== "allow") return set({ confirmAllow: true });
      void request({ type: "set_permissions", mode });
    },
    confirmAllowMode() {
      set({ confirmAllow: false });
      void request({ type: "set_permissions", mode: "allow" });
    },
    setEffort: (effort) => void request({ type: "set_effort", effort }),
    setLimit: (limit) => void request({ type: "set_limit", limit }),
    newSession: () => void request({ type: "new_session" }),
    resume: (id) => void request({ type: "resume", ref: id }),
    compact: (focus) => void request({ type: "compact", focus }),
    goal(text, verify, maxTurns) {
      if (request({ type: "goal", text, verify, max_turns: maxTurns })) {
        set((s) => ({
          items: [...s.items, { kind: "user", id: nextId("u"), text: `/goal ${text}${verify ? `  (check: ${verify})` : ""}` }],
          showGoal: false,
          goalRun: { text, verify, maxTurns, costAtStart: s.totalCost?.usd ?? null },
        }));
      }
    },
  };
});
