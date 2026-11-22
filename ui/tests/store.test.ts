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

describe("a denied call", () => {
  const call = { type: "tool_call" as const, id: "t1", name: "bash", input: { command: "rm x" }, display: "bash(rm x)" };
  const failed = { type: "tool_result" as const, id: "t1", name: "bash", text: "The user declined this. Do not repeat it.", is_error: true };

  it("is marked on the row when an error result follows the user saying no", () => {
    const s = run([call, failed], { ...initialState, denial: "user" });
    expect(s.items[0]).toMatchObject({ kind: "tool", isError: true, denied: "user", result: failed.text });
    expect(s.denial).toBeNull();
  });

  it("is marked as the judge's when a judge deny notice came first, and not for ordinary errors", () => {
    const j = run([{ type: "notice", text: "  judge: deny - deletes files" }, call, failed]);
    expect(j.items.find((i) => i.kind === "tool")).toMatchObject({ denied: "judge" });
    const plain = run([call, failed]);
    expect(plain.items[0]).not.toHaveProperty("denied");
  });
});

describe("structured events from the server", () => {
  const call = { type: "tool_call" as const, id: "t1", name: "bash", input: { command: "rm x" }, display: "bash(rm x)" };

  it("takes who decided from the result, and the outcome with it", () => {
    const allowed = run([call, { type: "tool_result", id: "t1", name: "bash", text: "exit code: 0", is_error: false, outcome: "exit 0", approval: { by: "judge", allowed: true }, mcp: false }]);
    expect(allowed.items[0]).toMatchObject({ outcome: "exit 0", approval: { by: "judge", allowed: true } });
    expect(allowed.items[0]).not.toHaveProperty("denied");
    // an exact answer wins over the old guess
    const denied = run([call, { type: "tool_result", id: "t1", name: "bash", text: "no", is_error: true, approval: { by: "user", allowed: false } }], { ...initialState, denial: "judge" });
    expect(denied.items[0]).toMatchObject({ denied: "user" });
    expect(denied.denial).toBeNull();
  });

  it("puts parallel group and subagent steps on the call", () => {
    const s = run([
      { ...call, name: "subagent", parallel_group: "t1" },
      { type: "subagent_step", parent_id: "t1", index: 1, display: "read_file(a.py)" },
      { type: "subagent_finish", parent_id: "t1", index: 1, calls: 2, cost: 0.003 },
    ]);
    expect(s.items[0]).toMatchObject({ group: "t1", index: 1, steps: ["read_file(a.py)"], finish: { calls: 2, cost: 0.003 } });
  });

  it("builds the goal card from goal events, and hands its steps to the result", () => {
    let s = run([
      { type: "goal_start", text: "tidy", verify: "true", max_turns: 2 },
      { type: "goal_round", n: 1 },
      { type: "goal_status", status: "claimed" },
      { type: "check_result", cmd: "true", passed: false, exit_code: 1 },
    ]);
    expect(s.goalLive).toMatchObject({ text: "tidy", verify: "true", maxTurns: 2, round: 1 });
    expect(s.goalLive?.lines.map((l) => l.marker)).toEqual([1, "ok", "bad"]);
    s = reduce(s, { type: "done", text: "GOAL NOT DONE after 1 round(s): x", stop_reason: null, cut_off: false, interrupted: false, stopped: "x", error: null, info });
    expect(s.goalLive).toBeNull();
    expect(s.items[0]).toMatchObject({ kind: "assistant", goal: { text: "tidy", verify: "true", maxTurns: 2 } });
    expect((s.items[0] as { goal: { lines: unknown[] } }).goal.lines).toHaveLength(3);
  });
});

describe("each write keeps its own change", () => {
  it("gives two edits of one file their own before and after, and the Changes tab the whole session", () => {
    const edit = (id: string) => ({ type: "tool_call" as const, id, name: "edit_file", input: { path: "a.py" }, display: "edit_file(a.py)" });
    const done = (id: string) => ({ type: "tool_result" as const, id, name: "edit_file", text: "ok", is_error: false });
    const s = run([
      edit("e1"), { type: "file_change", path: "a.py", before: "1\n", after: "2\n" }, done("e1"),
      edit("e2"), { type: "file_change", path: "a.py", before: "2\n", after: "3\n" }, done("e2"),
    ]);
    expect(s.items[0]).toMatchObject({ change: { before: "1\n", after: "2\n" } });
    expect(s.items[1]).toMatchObject({ change: { before: "2\n", after: "3\n" } });
    expect(s.changes["a.py"]).toEqual({ before: "1\n", after: "3\n" });
  });
});
