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
  plan?: boolean; // plan mode: read-only until a plan is approved
}

export type AttachmentKind = "image" | "pdf" | "text";

/** A file attached to a message: names and kinds only (the server never sends a file's contents back). */
export interface AttachmentRef {
  name: string;
  kind: AttachmentKind;
}

/** What POST /api/attachments returns: the file is on the server, waiting for a message to take it by id. */
export interface Uploaded extends AttachmentRef {
  id: string;
  size: number;
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
  | { type: "thinking_delta"; text: string } // the model's reasoning (a summary), as it streams
  | { type: "plan_request"; id: string; plan: string }
  | { type: "plan_mode"; on: boolean } // plan mode changed during a task (an approved plan turns it off)
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; display: string; parallel_group?: string | null }
  | {
      type: "tool_result";
      id: string;
      name: string;
      text: string;
      is_error: boolean;
      outcome?: string | null; // a few words on how it went ("612 lines", "exit 1"), made by the server
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
  | { kind: "user"; text: string; attachments?: AttachmentRef[] }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "summary"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; result: string | null; is_error: boolean; outcome?: string | null };

export type ClientRequest =
  | { type: "send"; text: string; attachments?: string[] }
  | { type: "cancel" }
  | { type: "answer_permission"; id: string; allow: boolean }
  | { type: "answer_ask"; id: string; answer: string | null }
  | { type: "answer_plan"; id: string; approve: boolean; feedback?: string }
  | { type: "set_plan"; on: boolean }
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
