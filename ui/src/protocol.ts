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
  index?: IndexStatus;
}

/** The document index behind search_docs, as the server reports it. */
export interface IndexStatus {
  available: boolean;
  files?: number;
  chunks?: number;
  last_sync?: number | null;
  building?: boolean;
  error?: string;
}

/** One passage search_docs found: where it is, how well it matched (only comparable within one search), and its text. */
export interface Source {
  chunk_id: string;
  path: string;
  start_line: number;
  end_line: number;
  score: number;
  snippet: string;
}

export interface Usage {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  searches?: number;
}

export interface Approval {
  by: "rule" | "judge" | "user";
  allowed: boolean;
}

export type ServerEvent =
  | { type: "hello"; info: Info; running: boolean; demo: boolean }
  | { type: "info"; info: Info }
  | { type: "status"; running: boolean }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; display: string; parallel_group?: string | null }
  | {
      type: "tool_result";
      id: string;
      name: string;
      text: string;
      is_error: boolean;
      outcome?: string | null; // a few words on how it went ("612 lines", "exit 1"), made by the server
      sources?: Source[]; // search_docs: the passages it found, best first (the text says the same for the model)
      approval?: Approval | null; // who decided a risky call; null when nothing was asked
      mcp?: boolean; // the result came from an MCP server (its first line says so)
    }
  | { type: "subagent_step"; parent_id: string; index: number | null; display: string }
  | { type: "subagent_finish"; parent_id: string; index: number | null; calls: number; cost: number | null }
  | { type: "goal_start"; text: string; verify: string | null; max_turns: number | null }
  | { type: "goal_round"; n: number }
  | { type: "goal_status"; status: "no_claim" | "no_evidence" | "claimed" | "reviewing" }
  | { type: "check_result"; cmd: string; passed: boolean; exit_code: number }
  | { type: "reviewer_verdict"; verdict: boolean | null }
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
      tool_id?: string | null; // the tool call this question is about
      hidden_explanation?: string | null; // a sentence for the findings panel, when there are findings
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
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; result: string | null; is_error: boolean; outcome?: string | null; sources?: Source[] };

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
  | { type: "index"; rebuild?: boolean }
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
