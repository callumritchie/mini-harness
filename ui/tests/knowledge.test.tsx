import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GraphResult, IndexStatus, SearchTrace, Source } from "../src/protocol";

const calls: { path: string; params?: Record<string, string> }[] = [];
let status: IndexStatus;
let graphAnswer: GraphResult | null = null;
vi.mock("../src/api", () => ({
  api: (path: string, params?: Record<string, string>) => {
    calls.push({ path, params });
    return Promise.resolve(path === "index" ? status : path === "graph/names" ? { names: [] } : { graph: graphAnswer });
  },
  getToken: () => "t",
}));

import { GraphCard, arrange, shortName } from "../src/components/GraphCard";
import { KnowledgePanel } from "../src/components/KnowledgePanel";
import { graphLines, searchLines } from "../src/components/LookupTrace";
import { ToolCard } from "../src/components/ToolCard";
import { TurnLookups } from "../src/components/TurnLookups";
import { lookupSummary, lookupTitle, sessionLookups, turnLookups } from "../src/lib/lookups";
import type { ToolItem } from "../src/lib/group";
import { initialState, reduce, useStore, type Item } from "../src/store";

afterEach(() => {
  cleanup();
  useStore.setState({ ...initialState });
  calls.length = 0;
});

const graph: GraphResult = {
  center: { id: 1, name: "pkg.app.Store", kind: "class", hop: 0 },
  alternatives: [{ id: 9, name: "pkg.other.Store", kind: "class", hop: 0 }],
  nodes: [
    { id: 1, name: "pkg.app.Store", kind: "class", hop: 0 },
    { id: 2, name: "pkg.app", kind: "module", hop: 1 },
    { id: 3, name: "pkg.base.Base", kind: "class", hop: 1 },
    { id: 4, name: "Storage", kind: "section", hop: 1 },
    { id: 5, name: "pkg.base", kind: "module", hop: 2 },
  ],
  edges: [
    { src: 2, dst: 1, relation: "defines", extractor: "structure-v1", path: "pkg/app.py", start_line: 1, end_line: 15, chunk_id: "a" },
    { src: 1, dst: 3, relation: "inherits", extractor: "structure-v1", path: "pkg/app.py", start_line: 1, end_line: 15, chunk_id: "a" },
    { src: 4, dst: 1, relation: "mentions", extractor: "llm-v1", path: "docs/guide.md", start_line: 5, end_line: 9, chunk_id: "b" },
    { src: 5, dst: 3, relation: "defines", extractor: "structure-v1", path: "pkg/base.py", start_line: 1, end_line: 2, chunk_id: "c" },
  ],
  mentioned_in: [{ path: "pkg/app.py", start_line: 1, end_line: 15, chunk_id: "a" }],
  truncated: false, matched: "ends", depth: 2, by_hop: [3, 1],
};

const trace: SearchTrace = { query: "cache rules", asked: "hybrid", used: "hybrid", prefix: null, searched: 592, embedded: 592, files: 130, pool: 20,
  keyword_found: 18, meaning_found: 11, floor: 0.5, fused: 24, kept: 4, shown: 4, tests_down: false };
const source: Source = { chunk_id: "s1", path: "docs/cache.md", start_line: 10, end_line: 49, score: 1, match: "both", snippet: "x" };
const tool = (over: Partial<ToolItem>): ToolItem =>
  ({ kind: "tool", id: "t", name: "search_docs", display: "search_docs(cache rules)", input: { query: "cache rules" }, result: "4 passages for",
    isError: false, status: "done", outcome: "4 snippets", ...over }) as ToolItem;

describe("connections, as lists", () => {
  it("splits what uses a name from what it uses, by relation, and names further away say how they are reached", () => {
    const { incoming, outgoing, far, via } = arrange(graph, true);
    expect(incoming.map((g) => g.label)).toEqual(["Defined in", "Mentioned in"]);
    expect(outgoing.map((g) => [g.label, g.rows.map((r) => r.node.name)])).toEqual([["Inherits from", ["pkg.base.Base"]]]);
    expect(far).toEqual([[2, [graph.nodes[4]]]]);
    expect(via.get(5)).toBe("pkg.base.Base");
    expect(arrange(graph, false).incoming.map((g) => g.label)).toEqual(["Defined in"]); // AI-inferred hidden
  });

  it("shows names whole, labels what a model inferred, and opens a citation at its lines", () => {
    const { container } = render(<GraphCard graph={graph} />);
    expect(screen.getByText("Store")).toBeTruthy(); // the centre's own name, then its full name under it
    expect(container.querySelector(".graph-full")?.textContent).toBe("pkg.app.Store");
    expect(screen.getByText("AI-inferred")).toBeTruthy();
    fireEvent.click(screen.getByText("guide.md:5–9"));
    expect(useStore.getState()).toMatchObject({ rightTab: "files", selectedFile: "docs/guide.md", selectedRange: { start: 5, end: 9 } });
    fireEvent.click(screen.getByLabelText(/Show AI-inferred/));
    expect(screen.queryByText("AI-inferred")).toBeNull();
    expect(shortName("pkg.app.VeryLongClassNameIndeed")).toBe("VeryLongClassNameIndeed");
    expect(shortName("docs/UX-SPEC.md")).toBe("UX-SPEC.md");
  });

  it("looks up another name when one is picked, and not without a handler", () => {
    const pick = vi.fn();
    render(<GraphCard graph={graph} onPick={pick} />);
    fireEvent.click(screen.getByText("Base"));
    fireEvent.click(screen.getByText("pkg.other.Store"));
    expect(pick.mock.calls.map((c) => c[0])).toEqual(["pkg.base.Base", "pkg.other.Store"]);
    cleanup();
    render(<GraphCard graph={graph} />);
    expect(screen.queryByRole("button", { name: /pkg.base.Base/ })).toBeNull();
  });

  it("says when it stopped early, with both numbers", () => {
    render(<GraphCard graph={{ ...graph, truncated: true }} />);
    expect(screen.getByText(/Stopped at 5 names: there are more/)).toBeTruthy();
  });
});

describe("a lookup explains itself", () => {
  it("says what a search looked through, what each way found, and what it kept", () => {
    const text = (lines: ReturnType<typeof searchLines>) => lines.map((l) => `${l.step}: ${render(<>{l.text}</>).container.textContent}`);
    expect(text(searchLines(trace))).toEqual([
      "Chunks: Looked through 592 chunks in 130 files.",
      "Search: keyword found 18, meaning found 11.",
      "Result: Combined 24 candidates and kept the best 4.",
    ]);
    cleanup();
    const off = text(searchLines({ ...trace, used: "keyword", meaning_found: null, floor: null, keyword_found: 20, fused: 20, shown: 0 }));
    expect(off[1]).toBe("Search: keyword found 20+. Search by meaning is off, so only the words were matched."); // 20 is the pool: "+"
    expect(off[2]).toBe("Result: Nothing close enough: the agent was told there were no matches.");
  });

  it("says how a map lookup found its name and how far it went", () => {
    const text = graphLines({ ...graph, truncated: true, by_hop: [39, 0, 0] }, "Store").map((l) => render(<>{l.text}</>).container.textContent);
    expect(text[0]).toBe("Started from Store in pkg.app by the end of its name (asked for “Store”). 1 other name matched.");
    expect(text[1]).toBe("39 direct connections, and hit the limit before going further.");
    expect(text[2]).toBe("Stopped at 5 names: there are more than the agent was shown.");
  });

  it("reads in plain words in the chat, and opens it in Knowledge", () => {
    const { container } = render(<ToolCard item={tool({ sources: [source], search: trace })} />);
    fireEvent.click(screen.getByText("Searched your files for “cache rules”"));
    expect(container.querySelector(".rc-summary")?.textContent).toBe("1 chunk from 1 file · of 592");
    fireEvent.click(screen.getByText("See in Knowledge"));
    expect(useStore.getState()).toMatchObject({ rightTab: "knowledge", rightOpen: true, knowledgeLookup: "t" });
    expect(lookupTitle({ name: "explore_graph", input: { name: "Store" } })).toBe("Followed the map from Store");
    expect(lookupTitle({ name: "search_docs", input: { query: "x", path_prefix: "src" } })).toBe("Searched your files in src for “x”");
  });
});

describe("lookups in a conversation", () => {
  const items: Item[] = [
    { kind: "user", id: "u1", text: "where?" },
    tool({ id: "a", sources: [source, { ...source, chunk_id: "s2", path: "src/app.py" }] }),
    tool({ id: "b", name: "explore_graph", input: { name: "Store" }, graph, sources: undefined }),
    { kind: "assistant", id: "r1", text: "Here." },
    { kind: "user", id: "u2", text: "thanks" },
    { kind: "assistant", id: "r2", text: "You're welcome." },
  ] as Item[];

  it("goes under the turn's last reply, only once the turn is over", () => {
    expect([...turnLookups(items, false).entries()].map(([id, t]) => [id, t.map((x) => x.id)])).toEqual([["r1", ["a", "b"]]]);
    expect(turnLookups(items.slice(0, 4), true).size).toBe(0); // still running: no line yet
    expect(sessionLookups(items).map((t) => t.id)).toEqual(["b", "a"]);
    expect(lookupSummary(turnLookups(items, false).get("r1")!)).toEqual({ searches: 1, maps: 1, snippets: 2, files: 2, names: 4 });
  });

  it("says what was read, never what the answer was based on, by file, each chunk saying which lookup found it", () => {
    const { container } = render(<TurnLookups tools={turnLookups(items, false).get("r1")!} />);
    const head = screen.getByText(/^Read /);
    expect(head.textContent).toBe("Read 2 chunks from 2 files · 1 map lookup");
    fireEvent.click(head);
    expect([...container.querySelectorAll(".tl-base")].map((b) => b.textContent)).toEqual(["cache.md", "app.py", "Store"]);
    fireEvent.click(screen.getAllByText("10–49")[1]);
    expect(useStore.getState()).toMatchObject({ selectedFile: "src/app.py", selectedRange: { start: 10, end: 49 } });
    fireEvent.click(screen.getAllByText("the search")[0]);
    expect(useStore.getState().revealTool).toBe("a");
  });
});

describe("the store and the graph", () => {
  it("keeps a search's trace and a graph live and after a reload, and an estimate opens the Knowledge tab", () => {
    let s = reduce(initialState, { type: "tool_call", id: "t1", name: "explore_graph", input: { name: "Store" }, display: "explore_graph(Store)" });
    s = reduce(s, { type: "tool_result", id: "t1", name: "explore_graph", text: "x", is_error: false, graph });
    s = reduce(s, { type: "tool_call", id: "t2", name: "search_docs", input: { query: "q" }, display: "search_docs(q)" });
    s = reduce(s, { type: "tool_result", id: "t2", name: "search_docs", text: "x", is_error: false, sources: [source], search: trace });
    expect(s.items[0]).toMatchObject({ graph });
    expect(s.items[1]).toMatchObject({ search: trace });
    s = reduce(s, { type: "graph_estimate", passages: 3, cached: 1, model: "claude-haiku-5-5", input_tokens: 900, output_tokens: 300, cost: 0.002, prose_only: true });
    expect(s.graphEstimate).toMatchObject({ passages: 3, model: "claude-haiku-5-5" });
    expect(s.rightTab).toBe("knowledge");
    s = reduce(s, { type: "index_status", status: { available: true, files: 3 } });
    expect(s.indexStatus).toEqual({ available: true, files: 3 });
  });

  it("sends /index --embed and /graph build as requests", () => {
    const sent: unknown[] = [];
    useStore.getState().setSocket({ send: (r) => { sent.push(r); return true; }, close: () => undefined });
    useStore.getState().submit("/index --embed");
    useStore.getState().submit("/graph build");
    useStore.getState().submit("/graph");
    expect(sent).toEqual([{ type: "index", rebuild: false, embed: true }, { type: "graph_estimate", prose_only: true }]);
    expect(useStore.getState().rightTab).toBe("knowledge");
    useStore.setState({ graphEstimate: { passages: 2, cached: 0, model: "m", input_tokens: 1, output_tokens: 1, cost: 0.01, prose_only: true } });
    useStore.getState().buildGraph();
    expect(sent[2]).toEqual({ type: "graph_build", prose_only: true, model: "m" });
    expect(useStore.getState().graphEstimate).toBeNull();
    useStore.getState().setSocket(null);
  });
});

describe("KnowledgePanel", () => {
  const base: IndexStatus = { available: true, files: 12, chunks: 40, entities: 30, edges: 55, last_sync: Date.now() / 1000, building: false,
    graph_building: false, embedding: null, embed_installed: false, embed_downloaded: false, embed_model: "BAAI/bge-small-en-v1.5", embed_size: "about 130 MB",
    skipped: { binary: 2, secret: 1 }, not_mapped: [[".ts", 4]], not_mapped_files: 4 };

  it("shows where the index is: a status line, the four stages, the last updates, and the details on request", async () => {
    status = { ...base, recent: [{ trigger: "after task", at: Date.now() / 1000 - 30, updated: 3, embedded: 12 }] };
    const { container } = render(<KnowledgePanel />);
    await waitFor(() => expect(screen.getByText(/Up to date · 40 chunks from 12 files/)).toBeTruthy());
    expect([...container.querySelectorAll(".lane")].map((l) => l.querySelector(".lane-name")?.textContent)).toEqual(["Files", "Chunks", "Vectors", "Map"]);
    expect(container.querySelector(".lane .lane-sub")?.textContent).toBe("3 left out");
    expect(container.querySelector(".ix-recent")?.textContent).toBe("After a task, just now: 3 re-cut, 12 chunks embedded");
    expect(screen.queryByText(/pip install -e/)).toBeNull(); // details stay closed until asked for
    fireEvent.click(screen.getByText(/Details:/));
    expect(screen.getByText(/3 left out: 2 not text, 1 secret/)).toBeTruthy();
    expect(screen.getByText(/pip install -e/)).toBeTruthy();
    fireEvent.click(screen.getByText("See left-out files"));
    expect(useStore.getState()).toMatchObject({ rightTab: "files", filesShow: "out" });
    cleanup();
    status = { ...base, embed_installed: true, embed_downloaded: true, embedder: "bge", embedded: 25, embedding: { done: 5, total: 15 } };
    useStore.setState({ indexStatus: null });
    const second = render(<KnowledgePanel />);
    await waitFor(() => expect(screen.getByText("5 of 15")).toBeTruthy());
    fireEvent.click(screen.getByText(/Details:/));
    expect(screen.getByText(/5 of 15 new chunks/)).toBeTruthy();
    expect(second.container.querySelector<HTMLElement>(".k-progress > span")?.style.transform).toBe(`scaleX(${5 / 15})`); // a third done
  });

  it("before anyone has chosen, or with search off, says so and offers the way on", async () => {
    status = { ...base, selection: null, allowed: false };
    render(<KnowledgePanel />);
    await waitFor(() => screen.getByText("Not set up. Choose what the agent can search."));
    fireEvent.click(screen.getByText("Choose…"));
    expect(useStore.getState()).toMatchObject({ rightTab: "files", filesChoose: true });
    cleanup();
    const sent: unknown[] = [];
    useStore.getState().setSocket({ send: (r) => { sent.push(r); return true; }, close: () => undefined });
    status = { ...base, selection: { off: true, excluded: [], included: [], gitignore: true }, allowed: false };
    useStore.setState({ indexStatus: null });
    render(<KnowledgePanel />);
    await waitFor(() => screen.getByText(/Search is off for this folder/));
    fireEvent.click(screen.getByText("Turn on"));
    expect(sent).toEqual([{ type: "choose_search" }]);
    useStore.getState().setSocket(null);
  });

  it("asks before adding concepts, showing the estimate", async () => {
    status = base;
    const sent: unknown[] = [];
    useStore.getState().setSocket({ send: (r) => { sent.push(r); return true; }, close: () => undefined });
    render(<KnowledgePanel />);
    await waitFor(() => screen.getByText(/Details:/));
    fireEvent.click(screen.getByText(/Details:/));
    fireEvent.click(screen.getByText("See what it would cost…"));
    expect(sent).toEqual([{ type: "graph_estimate", prose_only: true }]);
    act(() => useStore.setState({ graphEstimate: { passages: 7, cached: 0, model: "claude-haiku-5-5", input_tokens: 2100, output_tokens: 2450, cost: 0.0143, prose_only: true } }));
    const dialog = screen.getByRole("dialog", { name: "Add concepts from docs?" });
    expect(dialog.textContent).toContain("claude-haiku-5-5 would read 7 prose chunks");
    expect(dialog.textContent).toContain("$0.0143");
    fireEvent.click(screen.getByText("Not now"));
    expect(useStore.getState().graphEstimate).toBeNull();
    expect(sent).toHaveLength(1);
    useStore.getState().setSocket(null);
  });

  it("lists the agent's lookups, newest first, shows the picked one, and goes back to it in the chat", async () => {
    status = base;
    useStore.setState({ items: [
      { kind: "user", id: "u", text: "q" } as Item,
      tool({ id: "a", sources: [source], search: trace }),
      tool({ id: "b", name: "explore_graph", input: { name: "Store" }, graph, sources: undefined, outcome: "4 connections" }),
    ] });
    const { container } = render(<KnowledgePanel />);
    await waitFor(() => screen.getByText("The agent's lookups"));
    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => r.querySelector(".k-lookup-title")?.textContent)).toEqual(["Followed the map from Store", "Searched your files for “cache rules”"]);
    expect(rows[0].getAttribute("aria-selected")).toBe("true"); // the newest by default
    expect(container.querySelector(".k-results .lookup-trace")?.textContent).toContain("by the end of its name");
    act(() => useStore.setState({ knowledgeLookup: "a" })); // "See in Knowledge" from the chat
    await waitFor(() => expect(container.querySelector(".k-results .rc-summary")?.textContent).toBe("1 chunk from 1 file · of 592"));
    expect(useStore.getState().knowledgeLookup).toBeNull();
    fireEvent.click(screen.getAllByText("Show in chat")[1]);
    expect(useStore.getState().revealTool).toBe("a");
  });

  it("says what to do when there are no lookups yet, and opens Search yourself for a hand-off", async () => {
    status = base;
    graphAnswer = graph;
    render(<KnowledgePanel />);
    await waitFor(() => expect(screen.getByText(/No lookups yet/)).toBeTruthy());
    expect(screen.queryByLabelText("Search the chunks")).toBeNull(); // collapsed until wanted
    act(() => useStore.setState({ knowledgeQuery: "Base" })); // a name picked in a connection list
    await waitFor(() => expect(calls.at(-1)).toEqual({ path: "graph", params: { name: "Base", depth: "1" } }));
    expect(useStore.getState().knowledgeQuery).toBeNull();
  });
});
