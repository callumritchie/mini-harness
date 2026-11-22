import { describe, expect, it } from "vitest";
import { diffRows, diffStats, pairChanges } from "../src/lib/diff";
import { formatCost, formatTokens, languageFor } from "../src/lib/lang";

describe("diffRows", () => {
  it("shows a new file as all additions", () => {
    const rows = diffRows(null, "a\nb\n");
    expect(rows.map((r) => r.type)).toEqual(["add", "add"]);
    expect(diffStats(rows)).toEqual({ added: 2, removed: 0 });
  });

  it("numbers lines on both sides and marks changes", () => {
    const rows = diffRows("one\ntwo\nthree\n", "one\n2\nthree\n");
    expect(rows).toEqual([
      { type: "ctx", oldNo: 1, newNo: 1, text: "one" },
      { type: "del", oldNo: 2, text: "two" },
      { type: "add", newNo: 2, text: "2" },
      { type: "ctx", oldNo: 3, newNo: 3, text: "three" },
    ]);
  });

  it("folds long unchanged stretches", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const rows = diffRows(body, body.replace("line 20", "CHANGED"), 2);
    expect(rows.filter((r) => r.type === "gap")).toHaveLength(2);
    expect(rows.length).toBeLessThan(15);
  });
});

describe("formatting", () => {
  it("formats cost, tokens and languages", () => {
    expect(formatCost(0.0196)).toBe("$0.0196");
    expect(formatCost(12.5)).toBe("$12.50");
    expect(formatCost(null)).toBe("unknown");
    expect(formatCost(0.5, false)).toBe("$0.5000+");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(8)).toBe("8");
    expect(languageFor("src/app.py")).toBe("python");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("notes")).toBeUndefined();
  });
});

describe("diff details", () => {
  it("shows an emptied file as all removals", () => {
    const rows = diffRows("a\nb\n", "");
    expect(rows.map((r) => r.type)).toEqual(["del", "del"]);
    expect(diffStats(rows)).toEqual({ added: 0, removed: 2 });
  });

  it("keeps a folded gap's lines so the view can open them", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const after = before.replace("line 0\n", "line zero\n").replace("line 19\n", "line nineteen\n");
    const gap = diffRows(before, after).find((r) => r.type === "gap")!;
    expect(gap.hidden?.length).toBe(12);
    expect(gap.hidden?.[0]).toMatchObject({ type: "ctx", text: "line 4", oldNo: 5, newNo: 5 });
  });

  it("marks the words that changed between a removed line and the one that replaced it", () => {
    const rows = pairChanges(diffRows("keep\nA folder for demo use.\n", "keep\nA folder for the demo mode.\nNew line.\n"));
    const del = rows.find((r) => r.type === "del")!;
    const [add, extra] = rows.filter((r) => r.type === "add");
    expect(del.parts?.filter((p) => p.changed).map((p) => p.text.trim()).join("|")).toBe("use");
    expect(add.parts?.filter((p) => p.changed).map((p) => p.text.trim()).join("|")).toBe("the|mode");
    expect(del.parts?.map((p) => p.text).join("")).toBe(del.text);
    expect(add.parts?.map((p) => p.text).join("")).toBe(add.text);
    expect(extra.parts).toBeUndefined(); // an added line with nothing to pair with gets no marks
  });
});
