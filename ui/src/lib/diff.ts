import { diffLines } from "diff";

export interface DiffRow {
  type: "ctx" | "add" | "del" | "gap";
  oldNo?: number;
  newNo?: number;
  text: string;
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
      out.push({ type: "gap", text: `${run.length - keepHead - keepTail} unchanged lines` });
      out.push(...run.slice(run.length - keepTail));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  return {
    added: rows.filter((r) => r.type === "add").length,
    removed: rows.filter((r) => r.type === "del").length,
  };
}
