// The messages between the browser and the Python server (see DESIGN.md, "Web UI").

export type Mode = "ask" | "judge" | "allow";

export interface CostSummary {
  usd: number | null;
  complete: boolean;
  note: string | null;
}

export interface Info {
  project: string;
  model: string;
  provider: string;
  permissions: Mode;
  effort: string | null;
  limit: number;
  session_id: string;
  client_ready: boolean;
  client_error: string | null;
  efforts: string[];
  models: { id: string; note: string }[];
  modes: Mode[];
  mode_help: Record<string, string>;
  agents_md: boolean;
  skills: string[];
  mcp_tools: string[];
  price_known: boolean;
  cost: CostSummary;
  turns: number;
  compactions: number;
}

export interface Usage {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  searches?: number;
}

export type ServerEvent =
  | { type: "hello"; info: Info; running: boolean; demo: boolean }
  | { type: "info"; info: Info }
  | { type: "status"; running: boolean }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; display: string }
  | { type: "tool_result"; id: string; name: string; text: string; is_error: boolean }
  | { type: "usage"; usage: Usage; cost: number | null; total: CostSummary }
  | { type: "notice"; text: string }
  | { type: "file_change"; path: string; before: string | null; after: string | null }
  | {
      type: "permission_request";
      id: string;
      title: string;
      display: string[];
      findings: string[];
      reasons: string[];
      note: string | null;
      kind: string;
    }
  | { type: "ask_user"; id: string; question: string; choices: string[] }
  | { type: "question_closed"; id: string }
  | {
      type: "done";
      text: string;
      stop_reason: string | null;
      cut_off: boolean;
      interrupted: boolean;
      stopped: string | null;
      error: string | null;
      info: Info;
    }
  | { type: "session_loaded"; items: TranscriptItem[]; info: Info }
  | { type: "error"; message: string };

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "summary"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; result: string | null; is_error: boolean };

export type ClientRequest =
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "answer_permission"; id: string; allow: boolean }
  | { type: "answer_ask"; id: string; answer: string | null }
  | { type: "set_model"; model: string }
  | { type: "set_permissions"; mode: Mode }
  | { type: "set_effort"; effort: string | null }
  | { type: "set_limit"; limit: number }
  | { type: "new_session" }
  | { type: "resume"; ref: string }
  | { type: "compact"; focus?: string }
  | { type: "goal"; text: string; verify?: string; max_turns?: number };

export interface SessionRow {
  id: string;
  when: string;
  title: string;
  prompts: number;
  calls: number;
  cost: number;
  current: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  secret?: boolean;
  size?: number;
  children?: TreeNode[];
}

export interface ContextData {
  rows: Record<string, number>;
  total: number;
  window: number | null;
  limit: number;
  last_usage: Usage | null;
  totals: Record<string, number>;
  compactions: number;
  compact_disabled: boolean;
}
