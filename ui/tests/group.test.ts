import { describe, expect, it } from "vitest";
import { groupItems, groupLabel } from "../src/lib/group";
import type { Item } from "../src/store";

const tool = (id: string, name = "bash"): Item => ({ kind: "tool", id, name, display: `${name}()`, input: {}, result: null, isError: false, status: "done" });
const text = (id: string): Item => ({ kind: "assistant", id, text: "hi", streaming: false });

describe("groupItems", () => {
  it("folds runs of consecutive tools and leaves everything else alone", () => {
    const out = groupItems([text("a"), tool("1"), tool("2"), text("b"), tool("3")]);
    expect(out.map((e) => e.kind)).toEqual(["assistant", "group", "assistant", "group"]);
    expect(out[1]).toMatchObject({ id: "1", tools: [{ id: "1" }, { id: "2" }] });
    expect(out[3]).toMatchObject({ id: "3", tools: [{ id: "3" }] });
  });

  it("does not mutate its input and handles an empty list", () => {
    const items = [tool("1"), tool("2")];
    groupItems(items);
    expect(items).toHaveLength(2);
    expect(groupItems([])).toEqual([]);
  });
});

describe("groupLabel", () => {
  it("says subagents when all are, steps otherwise", () => {
    const sub = (id: string) => tool(id, "subagent") as Extract<Item, { kind: "tool" }>;
    expect(groupLabel([sub("1"), sub("2"), sub("3")])).toBe("3 subagents");
    expect(groupLabel([sub("1"), tool("2") as Extract<Item, { kind: "tool" }>])).toBe("2 steps");
  });
});
