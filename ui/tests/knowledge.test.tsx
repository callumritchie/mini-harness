import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GraphResult, IndexStatus } from "../src/protocol";

const calls: { path: string; params?: Record<string, string> }[] = [];
let status: IndexStatus;
let graphAnswer: GraphResult | null = null;
vi.mock("../src/api", () => ({
  api: (path: string, params?: Record<string, string>) => {
    calls.push({ path, params });
    return Promise.resolve(path === "index" ? status : { graph: graphAnswer });
  },
  getToken: () => "t",
}));

import { GraphCard, layout, shortName } from "../src/components/GraphCard";
import { KnowledgePanel } from "../src/components/KnowledgePanel";
import { ToolCard } from "../src/components/ToolCard";
import { initialState, reduce, useStore } from "../src/store";

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
  ],
  edges: [
    { src: 2, dst: 1, relation: "defines", extractor: "structure-v1", path: "pkg/app.py", start_line: 1, end_line: 15, chunk_id: "a" },
    { src: 1, dst: 3, relation: "inherits", extractor: "structure-v1", path: "pkg/app.py", start_line: 1, end_line: 15, chunk_id: "a" },
    { src: 4, dst: 1, relation: "mentions", extractor: "llm-v1", path: "docs/guide.md", start_line: 5, end_line: 9, chunk_id: "b" },
  ],
  mentioned_in: [{ path: "pkg/app.py", start_line: 1, end_line: 15, chunk_id: "a" }],
  truncated: false,
};

describe("GraphCard", () => {
  it("groups links by relation with their direction and source, and opens a citation at its lines", () => {
    const { container } = render(<GraphCard graph={graph} />);
    expect(container.querySelectorAll(".graph-group h4")).toHaveLength(3);
    expect(container.querySelectorAll(".g-node")).toHaveLength(4);
    expect(container.querySelector(".g-node.center text")?.textContent).toBe("Store");
    const inherits = [...container.querySelectorAll(".graph-link")].find((l) => l.textContent?.includes("pkg.base.Base"))!;
    expect(inherits.querySelector(".g-arrow")?.textContent).toBe("→");
    const defines = [...container.querySelectorAll(".graph-link")].find((l) => l.textContent?.includes("pkg.app") && l.textContent?.includes("module"))!;
    expect(defines.querySelector(".g-arrow")?.textContent).toBe("←");
    expect(screen.getByText("model")).toBeTruthy(); // a link a model found says so
    expect(container.querySelector(".g-edge.llm")).not.toBeNull();
    fireEvent.click(screen.getByText("docs/guide.md:5–9"));
    expect(useStore.getState()).toMatchObject({ rightTab: "files", selectedFile: "docs/guide.md", selectedRange: { start: 5, end: 9 } });
  });

  it("looks up another thing when one is picked, and not without a handler", () => {
    const pick = vi.fn();
    const { container } = render(<GraphCard graph={graph} onPick={pick} />);
    fireEvent.click(screen.getByText("pkg.base.Base"));
    fireEvent.click(screen.getByText("pkg.other.Store"));
    fireEvent.click(container.querySelector(".g-node.center")!); // the centre is already shown
    expect(pick.mock.calls.map((c) => c[0])).toEqual(["pkg.base.Base", "pkg.other.Store"]);
    cleanup();
    render(<GraphCard graph={graph} />);
    expect(screen.queryByRole("button", { name: "pkg.base.Base" })).toBeNull();
  });

  it("places nodes on rings and hides labels when there are many", () => {
    const many: GraphResult = { ...graph, nodes: [graph.center, ...Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, name: `n${i}`, kind: "function", hop: 1 }))],
      edges: Array.from({ length: 50 }, (_, i) => ({ ...graph.edges[0], src: 1, dst: 100 + i })) };
    const pos = layout(many.nodes);
    expect(pos.size).toBe(40); // drawn nodes are capped
    expect(pos.get(1)).toEqual({ x: 180, y: 110 }); // many nodes: the tallest picture (220)
    expect(layout(graph.nodes).get(1)).toEqual({ x: 180, y: 65 }); // a few: a shorter one
    const { container } = render(<GraphCard graph={many} />);
    expect(container.querySelectorAll(".g-node")).toHaveLength(40);
    expect(container.querySelectorAll(".g-node text")).toHaveLength(1); // only the centre is labelled
    expect(shortName("pkg.app.VeryLongClassNameIndeed")).toBe("VeryLongClassNa…");
    expect(shortName("Prompt cache")).toBe("Prompt cache");
    expect(shortName("README.md", 16, "document")).toBe("README.md");
    expect(shortName("docs/UX-SPEC.md")).toBe("UX-SPEC.md");
  });

  it("is what an explore_graph tool card shows, and a pick there opens the Knowledge tab", () => {
    render(<ToolCard item={{ kind: "tool", id: "g", name: "explore_graph", display: "explore_graph(Store)", input: { name: "Store" },
      result: "pkg.app.Store (class): 3 links:", isError: false, status: "done", outcome: "3 links", graph }} />);
    fireEvent.click(screen.getByText("explore_graph(Store)"));
    fireEvent.click(screen.getByText("pkg.base.Base"));
    expect(useStore.getState()).toMatchObject({ rightTab: "knowledge", rightOpen: true, knowledgeQuery: "pkg.base.Base" });
  });
});

describe("the store and the graph", () => {
  it("keeps a graph result live and after a reload, and an estimate opens the Knowledge tab", () => {
    let s = reduce(initialState, { type: "tool_call", id: "t1", name: "explore_graph", input: { name: "Store" }, display: "explore_graph(Store)" });
    s = reduce(s, { type: "tool_result", id: "t1", name: "explore_graph", text: "x", is_error: false, graph });
    expect(s.items[0]).toMatchObject({ graph });
    s = reduce(s, { type: "graph_estimate", passages: 3, cached: 1, model: "claude-haiku-5-5", input_tokens: 900, output_tokens: 300, cost: 0.002, prose_only: true });
    expect(s.graphEstimate).toMatchObject({ passages: 3, model: "claude-haiku-5-5" });
    expect(s.rightTab).toBe("knowledge");
    expect(s.graphEstimate).not.toHaveProperty("type");
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
    graph_building: false, embedding: null, embed_installed: false, embed_downloaded: false, embed_model: "BAAI/bge-small-en-v1.5", embed_size: "about 130 MB" };

  it("shows what is indexed and how to turn on search by meaning", async () => {
    status = base;
    render(<KnowledgePanel />);
    await waitFor(() => expect(screen.getByText("40")).toBeTruthy());
    expect(screen.getByText("not installed")).toBeTruthy();
    expect(screen.getByText(/pip install -e/)).toBeTruthy();
    cleanup();
    status = { ...base, embed_install: '"/opt/py/bin/python3" -m pip install -e ".[rag]"' };
    render(<KnowledgePanel />);
    await waitFor(() => expect(screen.getByText(/\/opt\/py\/bin\/python3/)).toBeTruthy());
    cleanup();
    status = { ...base, embed_installed: true };
    render(<KnowledgePanel />);
    await waitFor(() => expect(screen.getByText("Download model & embed")).toBeTruthy());
    expect(screen.getByText(/about 130 MB/)).toBeTruthy();
    cleanup();
    status = { ...base, embed_installed: true, embed_downloaded: true, embedder: "bge", embedded: 25, embedding: { done: 5, total: 15 } };
    const { container } = render(<KnowledgePanel />);
    await waitFor(() => expect(screen.getByText("25 of 40")).toBeTruthy());
    expect(container.querySelector<HTMLElement>(".k-progress > span")?.style.transform).toBe(`scaleX(${5 / 15})`); // a third done
  });

  it("asks before a paid graph build, showing the estimate", async () => {
    status = base;
    const sent: unknown[] = [];
    useStore.getState().setSocket({ send: (r) => { sent.push(r); return true; }, close: () => undefined });
    render(<KnowledgePanel />);
    await waitFor(() => screen.getByText("Build prose graph…"));
    fireEvent.click(screen.getByText("Build prose graph…"));
    expect(sent).toEqual([{ type: "graph_estimate", prose_only: true }]);
    act(() => useStore.setState({ graphEstimate: { passages: 7, cached: 0, model: "claude-haiku-5-5", input_tokens: 2100, output_tokens: 2450, cost: 0.0143, prose_only: true } }));
    const dialog = screen.getByRole("dialog", { name: "Build the prose graph?" });
    expect(dialog.textContent).toContain("claude-haiku-5-5 would read 7 passages");
    expect(dialog.textContent).toContain("$0.0143");
    fireEvent.click(screen.getByText("Cancel"));
    expect(useStore.getState().graphEstimate).toBeNull();
    expect(sent).toHaveLength(1);
    useStore.getState().setSocket(null);
  });

  it("looks things up, and follows a pick from a tool card", async () => {
    status = base;
    graphAnswer = graph;
    render(<KnowledgePanel />);
    await waitFor(() => screen.getByLabelText("Thing to look up"));
    fireEvent.change(screen.getByLabelText("Thing to look up"), { target: { value: "Store" } });
    fireEvent.click(screen.getByLabelText("Look up"));
    await waitFor(() => expect(screen.getByText("pkg.app.Store")).toBeTruthy());
    expect(calls.at(-1)).toEqual({ path: "graph", params: { name: "Store", depth: "1" } });
    act(() => useStore.setState({ knowledgeQuery: "Base" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ path: "graph", params: { name: "Base", depth: "1" } }));
    expect(useStore.getState().knowledgeQuery).toBeNull();
    graphAnswer = null;
    fireEvent.change(screen.getByLabelText("Thing to look up"), { target: { value: "zebra" } });
    fireEvent.click(screen.getByLabelText("Look up"));
    await waitFor(() => expect(screen.getByText(/Nothing in the graph matches/)).toBeTruthy());
  });
});
