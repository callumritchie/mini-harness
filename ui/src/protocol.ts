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
  index?: IndexStatus;
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

/** The document index behind search_docs and explore_graph, as the server reports it. */
export interface IndexStatus {
  available: boolean;
  files?: number;
  chunks?: number;
  entities?: number;
  edges?: number;
  last_sync?: number | null;
  building?: boolean;
  graph_building?: boolean;
  embedding?: { done: number; total: number } | null; // while passages are being embedded
  embedder?: string; // the model in use, once loaded
  embedded?: number; // passages with a vector from it
  embed_installed?: boolean; // the [rag] extra is installed
  embed_downloaded?: boolean; // its model is on this computer
  embed_model?: string;
  embed_size?: string;
  embed_install?: string; // the pip command for the Python running the server
  skipped?: Record<string, number>; // files left out, by reason (a key of SKIP_REASONS in lib/knowledgeWords.ts)
  capped?: boolean; // the project has more files than the index takes (max_files); the rest are not searched
  max_files?: number;
  location?: string; // where the index file lives (outside the project)
  not_mapped?: [string, number][]; // searchable files the map does not read, by extension, most first
  not_mapped_files?: number;
  skipped_folders?: Record<string, number>; // folders left out whole (recorded once, as "folder/"), by reason
  selection?: Selection | null; // what the person chose to search; null: nobody has chosen yet
  allowed?: boolean; // may the index be built and searched (chosen, and not "not now")
  recent?: IndexRun[]; // the last updates, oldest first
  error?: string;
}

/** What the person chose to search (the first-open question, or later from Files). */
export interface Selection {
  off: boolean; // "not now": nothing is indexed
  excluded: string[]; // folders or files left out
  included: string[]; // folders or files searched even though .gitignore leaves them out
  gitignore: boolean;
}

/** One update of the index, by what started it. */
export interface IndexRun {
  trigger: "start" | "after task" | "agent wrote" | "before search" | "first choice" | "choice changed" | "you asked" | string;
  at: number;
  added?: number;
  updated?: number;
  removed?: number;
  embedded?: number;
  paths?: string[];
  seconds?: number;
}

/** GET /api/index/plan: what searching this folder would take, before anything is indexed. */
export interface IndexPlan {
  folders: { path: string; files: number; bytes: number; gitignored_files: number; left_out: number; gitignored: boolean }[];
  files: number;
  bytes: number;
  chunks: number;
  left_out: number;
  gitignored: number;
  capped: boolean;
  empty: boolean;
  chosen: Selection | null;
}

/** GET /api/index/chunks: how one file is cut. */
export interface FileChunks {
  path: string;
  lines: number;
  kind: "code" | "markdown" | "prose";
  size: number; // lines per chunk
  overlap: number; // lines shared with the next chunk (windows only)
  chunks: { start: number; end: number; heading: string; embedded: boolean | null; names: string[] }[];
}

/** How the agent's search sees one file: in the index, or why not. "pending": new since the last update. "capped": past the file limit. */
export type IndexState = "in" | "pending" | "capped" | "secret" | "ignored_folder" | "outside" | "too_large" | "binary" | "not_utf8"
  | "minified" | "unreadable" | "not_chosen" | "gitignored";

/** GET /api/index/file: one file as the index sees it, and the name it goes by on the map. */
export interface IndexFile {
  path: string;
  state: IndexState | "unavailable";
  snippets?: number;
  connections?: number;
  entity?: string | null;
}

/** GET /api/search: the agent's search_docs, run by the person. `mode` is what was used (keyword when meaning is not set up). */
export interface SearchResult {
  sources: Source[];
  mode: "hybrid" | "keyword" | "meaning";
  asked: string;
  files: number;
  search?: SearchTrace;
}

/** One passage search_docs found: where it is, how well it matched (fused rank, 0-1, only comparable within one search), which
 *  ranking found it, and its text. */
export interface Source {
  chunk_id: string;
  path: string;
  start_line: number;
  end_line: number;
  score: number;
  match?: "keyword" | "meaning" | "both";
  bm25?: number | null;
  cosine?: number | null;
  heading?: string; // the Markdown section the passage starts in, as a breadcrumb ("Web UI › Protocol")
  is_test?: boolean; // from a test file (ranked lower unless the search was about tests)
  chunk_ids?: string[]; // the passages merged into this one (overlapping windows of one file)
  keyword_rank?: number | null; // its place in the keyword list (null: not in its top 4 x top_k)
  meaning_rank?: number | null; // its place in the meaning list
  file_lines?: number; // how long its file is, to draw where the passage sits
  snippet: string;
}

/** One entry of a ranking list in a search's trace. */
export interface Candidate {
  chunk_id: string;
  path: string;
  start_line: number;
  end_line: number;
  rank: number;
  score: number;
}

export interface GraphNode {
  id: number;
  name: string;
  kind: string;
  hop: number;
}

export interface GraphEdge {
  src: number;
  dst: number;
  relation: string;
  extractor: string; // structure-v1, or llm-v1 when a model read it from prose
  path: string;
  start_line: number;
  end_line: number;
  chunk_id: string;
}

/** explore_graph's answer: one thing and its neighbourhood, every link citing the passage it came from. */
export interface GraphResult {
  center: GraphNode;
  alternatives: GraphNode[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  mentioned_in: { path: string; start_line: number; end_line: number; chunk_id: string }[];
  truncated: boolean;
  matched?: "exact" | "ends" | "words"; // how the name was found
  depth?: number; // steps followed
  relation?: string | null; // only this kind of connection, if asked
  by_hop?: number[]; // names reached at each step: [direct, 2 steps, 3 steps]
}

/** How one search_docs call went, so the chat and the Knowledge tab can explain it step by step. Found counts are capped at
 *  `pool` (the candidates each way is asked for). */
export interface SearchTrace {
  query: string;
  asked: "hybrid" | "keyword" | "meaning";
  used: "hybrid" | "keyword" | "meaning"; // keyword when meaning is not set up
  prefix: string | null; // only under this folder or file
  searched: number; // snippets in scope
  embedded: number; // of those, with a vector for meaning
  files: number;
  pool: number;
  keyword_found: number | null; // null: keyword was not used
  meaning_found: number | null; // null: meaning was not used
  floor: number | null; // how close a meaning match must be
  fused?: number; // candidates after combining both lists
  kept?: number;
  shown: number; // results the agent was given
  tests_down?: boolean; // test files counted less
  building?: boolean; // the index was still being built
  candidates?: { keyword?: Candidate[]; meaning?: Candidate[] }; // each ranking's own top list, before combining
}

export interface GraphEstimate {
  passages: number;
  cached: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost: number | null;
  prose_only: boolean;
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
      sources?: Source[]; // search_docs: the passages it found, best first (the text says the same for the model)
      search?: SearchTrace; // search_docs: how the search went (what was searched, what each way found)
      graph?: GraphResult; // explore_graph: the neighbourhood it found
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
  | ({ type: "graph_estimate" } & GraphEstimate)
  | { type: "index_status"; status: IndexStatus } // while the page watches the index (watch_index): sent when it changes
  | { type: "error"; message: string };

export type TranscriptItem =
  | { kind: "user"; text: string; attachments?: AttachmentRef[] }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "summary"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; result: string | null; is_error: boolean; outcome?: string | null; sources?: Source[]; graph?: GraphResult; search?: SearchTrace };

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
  | { type: "index"; rebuild?: boolean; embed?: boolean }
  | { type: "watch_index"; on: boolean }
  | { type: "choose_search"; off?: boolean; excluded?: string[]; included?: string[]; gitignore?: boolean }
  | { type: "graph_estimate"; prose_only?: boolean; model?: string }
  | { type: "graph_build"; prose_only?: boolean; model?: string }
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
  idx?: IndexState; // files only: how the agent's search sees it (absent when there is no index)
  gi?: boolean; // left out by .gitignore (files and folders), shown when choosing what to search
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
