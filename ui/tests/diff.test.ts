import { describe, expect, it } from "vitest";
import { diffRows, diffStats } from "../src/lib/diff";
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
