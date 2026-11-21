import { describe, expect, it } from "vitest";
import { classifyNotice, compactingId } from "../src/lib/notice";
import { goalSummary } from "../src/lib/goal";
import { initialState, reduce } from "../src/store";
import type { Item } from "../src/store";

const n = (id: string, text: string): Item => ({ kind: "notice", id, text });
const user = (id: string, text: string): Item => ({ kind: "user", id, text });

describe("classifyNotice", () => {
  it("recognises retries and compaction by prefix, and leaves the rest plain", () => {
    expect(classifyNotice("  Server busy. Trying again in 4s (2/3).")).toBe("retry");
    expect(classifyNotice("● compacting 38 messages (~120,000 tokens, limit 150,000)...")).toBe("compacting");
    expect(classifyNotice("  compacted into a summary of about 3,400 tokens (server-side)")).toBe("compacted");
    expect(classifyNotice("  judge: allow - read only")).toBe("plain");
  });
});

describe("compactingId", () => {
  it("is the compacting notice until a result follows it", () => {
    expect(compactingId([n("a", "● compacting 3 messages")])).toBe("a");
    expect(compactingId([n("a", "● compacting 3 messages"), n("b", "  compacted into a summary of about 10 tokens")])).toBeNull();
    expect(compactingId([n("a", "● compacting 3 messages"), n("b", "  could not compact (x); carrying on...")])).toBeNull();
  });
});

describe("goalSummary", () => {
  const goal = [user("u", "/goal fix it"), n("1", "goal: fix it"), n("2", "  check: pytest"), n("3", "goal round 2: working..."), n("4", "  check `pytest`: FAILED (exit 1)"), n("5", "  reviewer (fresh, read-only, trusts nothing) is checking...")];

  it("reads the round, the latest check and the reviewer from the notice prefixes", () => {
    expect(goalSummary(goal, true)).toEqual({ text: "fix it", round: 2, check: "check `pytest`: FAILED (exit 1)", reviewer: "reviewer (fresh, read-only, trusts nothing) is checking..." });
  });

  it("starts from the /goal message when the server sends no goal: notice, and drops the check suffix from the text", () => {
    const items = [user("u", "/goal fix it  (check: pytest)"), n("3", "goal round 2: working...")];
    expect(goalSummary(items, true)).toEqual({ text: "fix it", round: 2, check: null, reviewer: null });
  });

  it("is hidden when no task is running or a normal message came after the goal", () => {
    expect(goalSummary(goal, false)).toBeNull();
    expect(goalSummary([...goal, user("u2", "thanks")], true)).toBeNull();
    expect(goalSummary([n("x", "  judge: allow")], true)).toBeNull();
  });
});

describe("turn endings", () => {
  const done = (o: Partial<Extract<Parameters<typeof reduce>[1], { type: "done" }>>) =>
    reduce(initialState, { type: "done", text: "", stop_reason: null, cut_off: false, interrupted: false, stopped: null, error: null, info: {} as never, ...o });

  it("tags stopped, not finished and cut off so each can look different", () => {
    expect(done({ interrupted: true }).items[0]).toMatchObject({ kind: "notice", tone: "stopped", text: "Stopped. That turn was dropped from the conversation." });
    expect(done({ stopped: "turn limit" }).items[0]).toMatchObject({ tone: "unfinished", text: "Not finished: turn limit" });
    expect(done({ cut_off: true }).items[0]).toMatchObject({ tone: "cutoff" });
  });
});
