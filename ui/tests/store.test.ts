import { describe, expect, it } from "vitest";
import { describeCall, initialState, reduce, type ChatState } from "../src/store";
import type { Info, ServerEvent } from "../src/protocol";

const info: Info = {
  project: "/p", model: "claude-opus-5-5", provider: "anthropic", permissions: "ask", effort: null, limit: 150000, session_id: "s1",
  client_ready: true, client_error: null, efforts: [], models: [], modes: ["ask", "judge", "allow"], mode_help: {}, agents_md: false, skills: [], mcp_tools: [],
  price_known: true, cost: { usd: 0, complete: true, note: null }, turns: 0, compactions: 0,
};

const run = (events: ServerEvent[], s: ChatState = initialState) => events.reduce(reduce, s);

describe("reduce", () => {
  it("streams text into one assistant message", () => {
    const s = run([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
  });

  it("pairs a tool call with its result and ends the streaming text before it", () => {
    const s = run([
      { type: "text_delta", text: "Looking" },
      { type: "tool_call", id: "t1", name: "glob", input: { pattern: "*" }, display: "glob(*)" },
      { type: "tool_result", id: "t1", name: "glob", text: "a.txt", is_error: false },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
    expect(s.items[0]).toMatchObject({ streaming: false });
    expect(s.items[1]).toMatchObject({ status: "done", result: "a.txt", isError: false });
  });

  it("ignores a tool call it already has", () => {
    const call: ServerEvent = { type: "tool_call", id: "t1", name: "glob", input: {}, display: "glob()" };
    expect(run([call, call]).items).toHaveLength(1);
  });

  it("shows a permission request until it is closed", () => {
    const s1 = run([{ type: "permission_request", id: "q1", title: "run a command", display: ["$ rm x"], findings: [], reasons: ["rm deletes files"], note: null, kind: "bash" }]);
    expect(s1.permission?.id).toBe("q1");
    expect(run([{ type: "question_closed", id: "other" }], s1).permission).not.toBeNull();
    expect(run([{ type: "question_closed", id: "q1" }], s1).permission).toBeNull();
  });

  it("keeps the first 'before' when a file changes twice", () => {
    const s = run([
      { type: "file_change", path: "a.py", before: null, after: "one" },
      { type: "file_change", path: "a.py", before: "one", after: "two" },
    ]);
    expect(s.changes["a.py"]).toEqual({ before: null, after: "two" });
    expect(s.selectedChange).toBe("a.py");
  });

  it("finishes a run: stops spinners, records usage, explains a stop", () => {
    const s = run([
      { type: "status", running: true },
      { type: "text_delta", text: "x" },
      { type: "tool_call", id: "t", name: "bash", input: {}, display: "bash()" },
      { type: "usage", usage: { input: 1, cache_read: 2, cache_write: 3, output: 4 }, cost: 0.01, total: { usd: 0.01, complete: true, note: null } },
      { type: "done", text: "", stop_reason: null, cut_off: false, interrupted: true, stopped: null, error: null, info: { ...info, cost: { usd: 0.01, complete: true, note: null } } },
    ]);
    expect(s.running).toBe(false);
    expect(s.items.find((i) => i.kind === "tool")).toMatchObject({ status: "done" });
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: "notice" });
    expect(s.lastUsage?.output).toBe(4);
    expect(s.totalCost?.usd).toBe(0.01);
  });

  it("shows errors and goal outcomes as messages", () => {
    const s = run([{ type: "done", text: "", stop_reason: null, cut_off: false, interrupted: false, stopped: null, error: "No key", info }]);
    expect(s.items[0]).toMatchObject({ kind: "error", text: "No key" });
    const g = run([{ type: "done", text: "GOAL DONE after 1 round(s).", stop_reason: null, cut_off: false, interrupted: false, stopped: null, error: null, info }]);
    expect(g.items[0]).toMatchObject({ kind: "assistant" });
  });

  it("replaces the conversation when a session is loaded", () => {
    const s = run(
      [{ type: "session_loaded", info, items: [{ kind: "user", text: "hi" }, { kind: "tool", id: "t", name: "glob", input: { pattern: "*" }, result: "a", is_error: false }] }],
      { ...initialState, changes: { "a.py": { before: null, after: "x" } }, items: [{ kind: "notice", id: "n", text: "old" }] },
    );
    expect(s.items.map((i) => i.kind)).toEqual(["user", "tool"]);
    expect(s.changes).toEqual({});
  });
});

describe("describeCall", () => {
  it("shows the most useful argument and cuts long ones", () => {
    expect(describeCall("bash", { command: "ls" })).toBe("bash(ls)");
    expect(describeCall("mcp__x__add", { a: 1, b: 2 })).toBe('mcp__x__add({"a":1,"b":2})');
    expect(describeCall("grep", { pattern: "x".repeat(200) }).length).toBeLessThan(140);
  });
});
