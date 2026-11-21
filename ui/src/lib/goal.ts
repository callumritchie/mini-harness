import type { Item } from "../store";

export interface GoalSummary {
  text: string;
  round: number;
  check: string | null;
  reviewer: string | null;
}

/** The goal text out of the "/goal <text>  (check: <cmd>)" line the page adds when a goal starts. */
function goalFromUser(text: string): string {
  return text.slice("/goal".length).split("  (check:")[0].trim();
}

/** What the pinned goal card shows while a goal runs. The goal starts at the latest "/goal" message (or a "goal:" notice); the round and the
 *  latest check and reviewer lines come from notice prefixes (`goal round`, `check`, `reviewer`) and nothing deeper. */
export function goalSummary(items: Item[], running: boolean): GoalSummary | null {
  if (!running) return null;
  let start = -1;
  let text = "";
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") {
      if (!it.text.startsWith("/goal")) return null; // a normal message came after: not a goal run
      start = i;
      text = goalFromUser(it.text);
      break;
    }
    if (it.kind === "notice" && it.text.trim().startsWith("goal:")) {
      start = i;
      text = it.text.trim().slice("goal:".length).trim();
      break;
    }
  }
  if (start < 0) return null;
  const summary: GoalSummary = { text, round: 1, check: null, reviewer: null };
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
