import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PathLabel, splitPath } from "../src/components/PathLabel";
import { ToolDisplay } from "../src/components/ToolCard";
import { Markdown } from "../src/components/Markdown";

afterEach(cleanup);

// worst-case values from the break-ui review: a deep monorepo path ending in an email-shaped file name
const DEEP = "src/integrations/northwind-industries-holdings/customer-records/2026-Q3/eu-west/bartholomew.fitzgerald@example.com.config.json";

describe("paths are shown file name first", () => {
  it("splits a path into folder and name", () => {
    expect(splitPath(DEEP)).toEqual({ dir: DEEP.slice(0, DEEP.lastIndexOf("/")), base: "bartholomew.fitzgerald@example.com.config.json" });
    expect(splitPath("README.md")).toEqual({ dir: "", base: "README.md" });
    expect(splitPath("docs/")).toEqual({ dir: "", base: "docs" });
  });

  it("puts the name before the folder and keeps the full path in the tooltip", () => {
    const { container } = render(<PathLabel path={DEEP} />);
    const label = container.querySelector(".pathlabel")!;
    expect(label.getAttribute("title")).toBe(DEEP);
    expect(label.querySelector(".pl-base")!.textContent).toBe("bartholomew.fitzgerald@example.com.config.json");
    expect(label.querySelector(".pl-dir")!.textContent).toContain("eu-west");
  });

  it("shows a file tool's call by its file name, with the folder after it", () => {
    const display = `write_file(${DEEP}, 600 chars)`;
    const { container } = render(<ToolDisplay display={display} name="write_file" path={DEEP} />);
    expect(container.querySelector(".td-main")!.textContent).toBe("write_file(bartholomew.fitzgerald@example.com.config.json, 600 chars)");
    expect(container.querySelector(".td-dir")!.textContent).toBe(splitPath(DEEP).dir);
    expect(container.querySelector(".tool-display")!.getAttribute("title")).toBe(display);
  });

  it("leaves a display alone when the path is at the root, the tool is not a file tool, or the display doesn't hold the path", () => {
    for (const [display, name, path] of [["write_file(demo.py, 3 chars)", "write_file", "demo.py"], ["bash(ls src/a)", "bash", "src/a"],
      ["read_file(⟨U+202E⟩x/y)", "read_file", "x/‮y"]] as const) {
      const { container, unmount } = render(<ToolDisplay display={display} name={name} path={path} />);
      expect(container.querySelector(".td-main")!.textContent).toBe(display);
      expect(container.querySelector(".td-dir")).toBeNull();
      unmount();
    }
  });
});

describe("wide content in a reply stays inside the column", () => {
  it("wraps a table in its own scrolling box", () => {
    const { container } = render(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelector(".table-wrap > table")).not.toBeNull();
  });
});
