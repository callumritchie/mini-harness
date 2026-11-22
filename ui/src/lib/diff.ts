import { diffLines, diffWordsWithSpace } from "diff";

/** A piece of a changed line: `changed` marks the words that differ from the line it replaced (or that replaced it). */
export interface Part {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  type: "ctx" | "add" | "del" | "gap";
  oldNo?: number;
  newNo?: number;
  text: string;
  hidden?: DiffRow[]; // a gap's folded lines, so the view can open them
  parts?: Part[]; // word-level changes, when this line pairs with one on the other side
}

/** Line diff between two versions of a file (before is null for a new file), with long unchanged stretches folded away. */
export function diffRows(before: string | null, after: string | null, context = 3): DiffRow[] {
  const parts = diffLines(before ?? "", after ?? "");
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const part of parts) {
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const text of lines) {
      if (part.added) rows.push({ type: "add", newNo: newNo++, text });
      else if (part.removed) rows.push({ type: "del", oldNo: oldNo++, text });
      else rows.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  // fold runs of unchanged lines longer than 2*context
  const out: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type !== "ctx") {
      out.push(rows[i++]);
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].type === "ctx") j++;
    const run = rows.slice(i, j);
    const first = i === 0;
    const last = j === rows.length;
    const keepHead = first ? 0 : context;
    const keepTail = last ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead));
      out.push({ type: "gap", text: `${run.length - keepHead - keepTail} unchanged lines`, hidden: run.slice(keepHead, run.length - keepTail) });
      out.push(...run.slice(run.length - keepTail));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

const WORD_DIFF_MAX = 2000; // longer lines are shown whole, like CodeLine's highlighting limit

/** Pair each run of removed lines with the run of added lines right after it, line by line, and mark the words that changed.
 *  Unpaired lines (pure additions or removals) get no marks. Returns new rows; the input is not changed. */
export function pairChanges(rows: DiffRow[]): DiffRow[] {
  const out = rows.map((r) => ({ ...r }));
  let i = 0;
  while (i < out.length) {
    if (out[i].type !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < out.length && out[d].type === "del") d++;
    let a = d;
    while (a < out.length && out[a].type === "add") a++;
    const pairs = Math.min(d - i, a - d);
    for (let k = 0; k < pairs; k++) {
      const del = out[i + k];
      const add = out[d + k];
      if (del.text.length > WORD_DIFF_MAX || add.text.length > WORD_DIFF_MAX) continue;
      const parts = diffWordsWithSpace(del.text, add.text);
      del.parts = parts.filter((p) => !p.added).map((p) => ({ text: p.value, changed: !!p.removed }));
      add.parts = parts.filter((p) => !p.removed).map((p) => ({ text: p.value, changed: !!p.added }));
    }
    i = a;
  }
  return out;
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((r) => r.type === "add").length,
    removed: rows.filter((r) => r.type === "del").length,
  };
}
