import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { createBatcher, splitBlocks } from "../src/lib/stream";
import { Markdown } from "../src/components/Markdown";
import type { ServerEvent } from "../src/protocol";

afterEach(cleanup);

const REPLY = [
  "### Step 1\n\nThis step maps the fields.",
  "```python\ndef f(x):\n\n    return x  # a blank line inside the fence\n```",
  "1. first item\n\n   still the first item (indented continuation)\n2. second",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "~~~\nnot closed by ```python\n~~~",
  "The end, with a [link](https://example.com).",
].join("\n\n");

describe("splitBlocks", () => {
  it("splits at blank lines between top-level blocks and joins back to the same text", () => {
    const blocks = splitBlocks(REPLY);
    expect(blocks.join("\n\n")).toBe(REPLY);
    expect(blocks).toHaveLength(7); // the heading and its paragraph are two blocks
  });

  it("never splits inside a code fence or before an indented continuation", () => {
    const blocks = splitBlocks(REPLY);
    expect(blocks[2]).toContain("return x");
    expect(blocks[3]).toContain("still the first item");
    expect(blocks[5]).toBe("~~~\nnot closed by ```python\n~~~");
  });

  it("keeps a fence that is still open (mid-stream) in one block", () => {
    expect(splitBlocks("Intro\n\n```ts\nconst a = 1;\n\nconst b")).toEqual(["Intro", "```ts\nconst a = 1;\n\nconst b"]);
  });
});

describe("streaming markdown", () => {
  it("renders the same HTML block by block as it does whole (bar the newlines between top-level elements, which don't render)", () => {
    const html = (streaming: boolean) => {
      const out = render(<Markdown text={REPLY} streaming={streaming} />).container.innerHTML.replace(/>\n</g, "><");
      cleanup();
      return out;
    };
    expect(html(true)).toBe(html(false));
  });
});

describe("createBatcher", () => {
  it("applies streamed words once per frame, and flushes them before any other event so order never changes", () => {
    const applied: string[][] = [];
    let pending: (() => void) | null = null;
    const b = createBatcher((evs) => applied.push(evs.map((e) => e.type === "text_delta" ? e.text : e.type)), (f) => { pending = f; });
    const word = (text: string) => ({ type: "text_delta", text }) as ServerEvent;
    b.push(word("a")); b.push(word("b")); b.push(word("c"));
    expect(applied).toEqual([]); // waiting for the frame
    pending!();
    expect(applied).toEqual([["a", "b", "c"]]);
    b.push(word("d"));
    b.push({ type: "tool_call" } as ServerEvent); // not a delta: what is waiting goes first, then it
    expect(applied).toEqual([["a", "b", "c"], ["d"], ["tool_call"]]);
    pending!(); // the frame that was scheduled for "d" finds nothing left to do
    expect(applied).toHaveLength(3);
  });
});
