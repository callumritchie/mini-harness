import type { Item } from "../store";

export interface GoalSummary {
  text: string;
  round: number;
  check: string | null;
  reviewer: string | null;
}

/** What the pinned goal card shows while a goal runs, read from the notice prefixes `goal`, `check` and `reviewer` only. */
export function goalSummary(items: Item[], running: boolean): GoalSummary | null {
  if (!running) return null;
  let start = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user" && !it.text.startsWith("/goal")) return null; // a normal message came after: not a goal run
    if (it.kind === "notice" && it.text.trim().startsWith("goal:")) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const summary: GoalSummary = { text: (items[start] as Extract<Item, { kind: "notice" }>).text.trim().slice("goal:".length).trim(), round: 1, check: null, reviewer: null };
  for (const it of items.slice(start + 1)) {
    if (it.kind !== "notice") continue;
    const t = it.text.trim();
    const round = /^goal round (\d+)/.exec(t);
    if (round) summary.round = Number(round[1]);
    else if (t.startsWith("check")) summary.check = t;
    else if (t.startsWith("reviewer")) summary.reviewer = t;
  }
  return summary;
}
