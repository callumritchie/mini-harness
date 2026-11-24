import type { ReactNode } from "react";

// One icon set, drawn like the design: a 16-unit grid, 1.5 strokes, plain caps. Sizes are 12 (chevrons), 14 (rows), 16 (bars, tiles), 18 (menus).
const FILE = <path d="M4 2h5l3 3v9H4zM9 2v3h3" />;
const PENCIL = <path d="M2.5 13.5l2.8-.6 7.4-7.4a1.4 1.4 0 0 0-2-2L3.3 10.9z" />;
const SHIELD = <path d="M8 1.5l5 2v4c0 3-2.2 5.5-5 7-2.8-1.5-5-4-5-7v-4z" />;
const SEARCH = <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>;

const PATHS: Record<string, ReactNode> = {
  menu: <path d="M3 4.5h10M3 8h10M3 11.5h10" />,
  panel: <><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M10 2.5v11" /></>,
  pencil: PENCIL,
  search: SEARCH,
  "no-search": <>{SEARCH}<path d="M2.5 2.5l11 11" /></>,
  goal: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" /></>,
  compact: <path d="M3 4h10M3 8h10M3 12h6" />,
  send: <path d="M8 13V3M4 7l4-4 4 4" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  "chevron-right": <path d="M6 3l5 5-5 5" />,
  "chevron-down": <path d="M4 6l4 4 4-4" />,
  back: <path d="M10 3l-5 5 5 5" />,
  stop: <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  shield: SHIELD,
  "shield-judge": <>{SHIELD}<path d="M8 4v8" /></>,
  "shield-x": <>{SHIELD}<path d="M6 6l4 4M10 6l-4 4" /></>,
  warning: <path d="M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.5" />,
  "alert-circle": <><circle cx="8" cy="8" r="6" /><path d="M8 5v3.5M8 10.5v.5" /></>,
  "x-circle": <><circle cx="8" cy="8" r="6" /><path d="M6 6l4 4M10 6l-4 4" /></>,
  check: <path d="M3 8.5l3 3 7-7" />,
  x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  terminal: <path d="M3 4.5l3 3-3 3M8 11h5" />,
  file: FILE,
  "file-plus": <>{FILE}<path d="M6 9h4M8 7v4" /></>,
  edit: PENCIL,
  grep: SEARCH,
  globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c2 2 2 9 0 11M8 2.5c-2 2-2 9 0 11" /></>,
  plug: <path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14" />,
  bubble: <path d="M2.5 4.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  subagent: <><circle cx="4" cy="4" r="1.75" /><circle cx="12" cy="12" r="1.75" /><path d="M4 5.75V9a3 3 0 0 0 3 3h3.25" /></>,
  play: <path d="M5 3.5l7 4.5-7 4.5z" />,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  retry: <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5" />,
  cut: <path d="M3 8h7M8 5l3 3-3 3M13 4v8" />,
  copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  user: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" /></>,
  plan: <path d="M6.5 4h7M6.5 8h7M6.5 12h7M2.5 4l.8.8 1.4-1.6M2.5 8l.8.8 1.4-1.6M2.7 12h1.6" />,
  paperclip: <path d="M13 7.5l-5.3 5.3a3 3 0 0 1-4.2-4.2l5.6-5.6a2 2 0 0 1 2.8 2.8L6.4 11.3a1 1 0 0 1-1.4-1.4l4.9-4.9" />,
  thought: <><path d="M5 11.5a3.5 3.5 0 1 1 1.3-6.7 3 3 0 0 1 5.4 1.5 2.6 2.6 0 0 1-.7 5.2z" /><circle cx="3.5" cy="14" r=".8" /></>,
  image: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="6.5" r="1.2" /><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3" /></>,
  docs: <><path d="M3 2.5h6.5l3.5 3.5v7.5H3z" /><circle cx="7.5" cy="9" r="2" /><path d="M9 10.5l2 2" /></>,
  graph: <><circle cx="8" cy="8" r="1.75" /><circle cx="3" cy="3.5" r="1.5" /><circle cx="13" cy="4" r="1.5" /><circle cx="4" cy="13" r="1.5" /><path d="M6.6 7L4.1 4.6M9.5 7.2l2.3-2.2M6.8 9.3L5 11.8" /></>,
};

export type IconName = keyof typeof PATHS;

const THIN = new Set(["chevron-right", "chevron-down", "back"]);

export function Icon({ name, size = 14, className, strokeWidth }: { name: IconName; size?: number; className?: string; strokeWidth?: number }) {
  return (
    <svg className={className ? `icon-svg ${className}` : "icon-svg"} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth ?? (THIN.has(name) ? 1.7 : 1.5)} aria-hidden>
      {PATHS[name]}
    </svg>
  );
}

const TOOL_ICON: Record<string, IconName> = {
  bash: "terminal", read_file: "file", write_file: "file-plus", edit_file: "edit", glob: "folder", grep: "grep", web_search: "globe",
  ask_user: "bubble", subagent: "subagent", code_execution: "play", exit_plan_mode: "plan", search_docs: "docs", explore_graph: "graph",
};

/** The icon for a tool call; every MCP tool (and anything unknown) gets the plug. */
export function toolIcon(name: string): IconName {
  return TOOL_ICON[name] ?? "plug";
}
