import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IndexPlan, TreeNode } from "../src/protocol";

let plan: IndexPlan;
vi.mock("../src/api", () => ({ api: () => Promise.resolve(plan), getToken: () => "t" }));

import { countTicked, fromSelection, ticked, toRequest, toggle } from "../src/lib/choose";
import { FirstOpen } from "../src/components/FirstOpen";
import { FileBar } from "../src/components/RetrievalCard";
import { runLine } from "../src/components/IndexLanes";
import { initialState, useStore } from "../src/store";

afterEach(() => {
  cleanup();
  useStore.setState({ ...initialState });
});

const file = (path: string, extra: Partial<TreeNode> = {}): TreeNode => ({ name: path.split("/").pop()!, path, type: "file", ...extra }) as TreeNode;
const tree: TreeNode[] = [
  { name: "src", path: "src", type: "dir", children: [file("src/a.py"), file("src/b.py")] } as TreeNode,
  { name: "dist", path: "dist", type: "dir", gi: true, children: [file("dist/x.js", { gi: true })] } as TreeNode,
  file("package-lock.json"), file(".env", { secret: true }),
];

describe("choosing what the agent may search", () => {
  it("starts from .gitignore: ignored folders unticked, secrets never counted", () => {
    const c = fromSelection(null);
    expect(countTicked(tree, c)).toEqual({ on: 3, all: 4 });
    expect(ticked(tree[1], c)).toBe(false);
  });

  it("unticks a folder or a single file, and ticks back what .gitignore left out", () => {
    let c = toggle(tree[0], fromSelection(null)); // untick src/
    expect(countTicked(tree, c)).toEqual({ on: 1, all: 4 });
    c = toggle(tree[0], c); // and back
    c = toggle(tree[2], c); // untick package-lock.json alone
    c = toggle(tree[1], c); // tick dist/ although .gitignore lists it
    expect(toRequest(c)).toEqual({ excluded: ["package-lock.json"], included: ["dist"] });
    expect(countTicked(tree, c)).toEqual({ on: 3, all: 4 });
    expect(toRequest(toggle(tree[1], c))).toEqual({ excluded: ["dist", "package-lock.json"], included: [] }); // unticking wins
  });
});

describe("the first-open question", () => {
  const base: IndexPlan = { folders: [{ path: "", files: 3, bytes: 4000, gitignored_files: 0, left_out: 0, gitignored: false }], files: 164, bytes: 2_000_000,
    chunks: 710, left_out: 90, gitignored: 6, capped: false, empty: false, chosen: null };

  it("says what would be searched, and each answer sends the choice", async () => {
    plan = base;
    const sent: unknown[] = [];
    useStore.getState().setSocket({ send: (r) => { sent.push(r); return true; }, close: () => undefined });
    useStore.setState({ indexStatus: { available: true, selection: null, allowed: false } });
    render(<FirstOpen />);
    await waitFor(() => screen.getByText("Let the agent search this folder?"));
    expect(screen.getByText(/164 text files/).parentElement?.textContent).toBe("164 text files · 2.0 MB · about 710 chunks");
    expect(screen.getByText(/Left out: 6 in .gitignore and 90 images, binaries or secret files/)).toBeTruthy();
    fireEvent.click(screen.getByText("Search everything"));
    fireEvent.click(screen.getByText("Not now"));
    expect(sent).toEqual([{ type: "choose_search" }, { type: "choose_search", off: true }]);
    fireEvent.click(screen.getByText("Choose folders…"));
    expect(useStore.getState()).toMatchObject({ rightOpen: true, rightTab: "files", filesChoose: true });
    useStore.getState().setSocket(null);
  });

  it("isn't shown once chosen, for an empty folder, or before the status is known", async () => {
    plan = { ...base, empty: true };
    useStore.setState({ indexStatus: { available: true, selection: null, allowed: false } });
    const { container } = render(<FirstOpen />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe("");
    cleanup();
    plan = base;
    useStore.setState({ indexStatus: { available: true, selection: { off: false, excluded: [], included: [], gitignore: true }, allowed: true } });
    expect(render(<FirstOpen />).container.textContent).toBe("");
  });
});

describe("where a chunk sits, and what an update did", () => {
  it("draws each run of lines at its place in the file", () => {
    const { container } = render(<FileBar lines={200} runs={[{ start: 1, end: 50, key: "a" }, { start: 151, end: 200, key: "b" }]} label="x" />);
    expect([...container.querySelectorAll<HTMLElement>(".file-bar span")].map((s) => [s.style.left, s.style.width])).toEqual([["0%", "25%"], ["75%", "25%"]]);
  });

  it("says what started an update and what it changed", () => {
    const at = Date.now() / 1000;
    expect(runLine({ trigger: "agent wrote", at, paths: ["src/a.py"], updated: 1 })).toBe("The agent wrote a file, just now (a.py): 1 re-cut");
    expect(runLine({ trigger: "start", at })).toBe("When the app started, just now: nothing had changed");
  });
});
