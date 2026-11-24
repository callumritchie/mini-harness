import type { Selection, TreeNode } from "../protocol";

/** Choosing what the agent may search, in the Files tab: which folders and files are ticked. A path is ticked unless it, or a
 *  folder it is in, was unticked; something .gitignore leaves out starts unticked unless it was ticked on purpose. */
export interface Choice {
  off: Set<string>; // unticked by the person (folders or files)
  on: Set<string>; // ticked although .gitignore leaves them out
}

const under = (path: string, set: Set<string>) => {
  for (const p of set) if (path === p || path.startsWith(p + "/")) return true;
  return false;
};

export const fromSelection = (sel: Selection | null | undefined): Choice => ({ off: new Set(sel?.excluded ?? []), on: new Set(sel?.included ?? []) });

/** Is this node searched, and could its box be changed (a file inside an unticked folder can't be ticked on its own)? */
export function ticked(node: TreeNode, c: Choice, giAbove = false): boolean {
  if (under(node.path, c.off)) return false;
  return !(node.gi || giAbove) || under(node.path, c.on);
}

/** Files under a node that would be searched, and how many there are (secret files never count). */
export function countTicked(nodes: TreeNode[], c: Choice, giAbove = false): { on: number; all: number } {
  let on = 0, all = 0;
  for (const n of nodes) {
    if (n.type === "dir") {
      const sub = countTicked(n.children ?? [], c, giAbove || Boolean(n.gi));
      on += sub.on;
      all += sub.all;
    } else if (!n.secret) {
      all += 1;
      if (ticked(n, c, giAbove)) on += 1;
    }
  }
  return { on, all };
}

/** Tick or untick a folder or file. Unticking a folder drops the choices made inside it; ticking one brings it all back. */
export function toggle(node: TreeNode, c: Choice, giAbove = false): Choice {
  const off = new Set([...c.off].filter((p) => !(p === node.path || p.startsWith(node.path + "/"))));
  const on = new Set([...c.on].filter((p) => !(p === node.path || p.startsWith(node.path + "/"))));
  if (ticked(node, c, giAbove)) off.add(node.path); // unticking always wins
  else if ((node.gi || giAbove) && !under(node.path, off)) on.add(node.path); // bring back what .gitignore left out
  return { off, on };
}

/** What to send: the shortest lists that say the same thing. */
export const toRequest = (c: Choice) => ({ excluded: [...c.off].sort(), included: [...c.on].sort() });
