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

export type RoundMarker = number | "ok" | "bad" | "spin" | "dot";
export interface RoundLine {
  id: string;
  marker: RoundMarker;
  text: string;
}

const GOAL_NOTICE = /^(goal round \d+|no claim of done|claimed done|claims it is done|check|reviewer)/;

/** A goal-progress notice (round, claim, check or reviewer line), by prefix only. */
export function isGoalNotice(text: string): boolean {
  return GOAL_NOTICE.test(text.trim());
}

/** One readable line per goal notice, with a marker: the round number, ✓, ✕, or a spinner on the last line while it still runs. */
export function roundLines(items: Item[], live: boolean): RoundLine[] {
  const lines: RoundLine[] = [];
  for (const it of items) {
    if (it.kind !== "notice" || !isGoalNotice(it.text)) continue;
    const t = it.text.trim();
    const round = /^goal round (\d+)/.exec(t);
    const marker: RoundMarker = round ? Number(round[1])
      : /passed|claims it is done|verdict: DONE/.test(t) ? "ok"
      : /FAILED|verdict: NOT DONE|without evidence/.test(t) ? "bad" : "dot";
    lines.push({ id: it.id, marker, text: t[0].toUpperCase() + t.slice(1) });
  }
  if (live && lines.length) lines[lines.length - 1] = { ...lines[lines.length - 1], marker: "spin" };
  return lines;
}

/** Where each goal's notices live: from its "/goal" message to the next message from the person. Notices of a goal that is running
 *  or has a result are tucked away (the goal card and the result card show them); a goal that was stopped keeps them in the thread. */
export function goalSpans(items: Item[], running: boolean): { hidden: Set<string>; byOutcome: Map<string, Item[]> } {
  const hidden = new Set<string>();
  const byOutcome = new Map<string, Item[]>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "user" || !it.text.startsWith("/goal")) continue;
    let end = i + 1;
    while (end < items.length && items[end].kind !== "user") end++;
    const span = items.slice(i + 1, end);
    const outcome = span.find((x) => x.kind === "assistant" && x.text.startsWith("GOAL"));
    const live = running && end === items.length;
    if (!outcome && !live) continue;
    for (const x of span) if (x.kind === "notice" && isGoalNotice(x.text)) hidden.add(x.id);
    if (outcome) byOutcome.set(outcome.id, span);
  }
  return { hidden, byOutcome };
}
