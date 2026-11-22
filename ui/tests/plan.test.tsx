import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanCard } from "../src/components/PlanCard";
import { Thinking } from "../src/components/Thinking";
import { Message } from "../src/components/Message";
import { fromTranscript, initialState, reduce, useStore, type ChatState } from "../src/store";
import type { Info, ServerEvent } from "../src/protocol";

const info: Info = {
  project: "/p", model: "claude-opus-5-5", provider: "anthropic", permissions: "ask", effort: null, limit: 150000, session_id: "s1",
  client_ready: true, client_error: null, efforts: [], models: [], modes: ["ask", "judge", "allow"], mode_help: {}, agents_md: false, skills: [], mcp_tools: [],
  price_known: true, cost: { usd: 0, complete: true, note: null }, turns: 0, compactions: 0, plan: false,
};
const run = (events: ServerEvent[], s: ChatState = initialState) => events.reduce(reduce, s);

afterEach(() => {
  cleanup();
  useStore.setState({ ...initialState });
});

describe("reasoning", () => {
  it("streams into its own item, which ends when the reply starts", () => {
    const s = run([
      { type: "thinking_delta", text: "Let me " },
      { type: "thinking_delta", text: "look." },
      { type: "text_delta", text: "Done" },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["thinking", "assistant"]);
    expect(s.items[0]).toMatchObject({ text: "Let me look.", streaming: false });
    expect(s.items[1]).toMatchObject({ streaming: true });
  });

  it("is open while it streams and folds away when finished", () => {
    const { container, rerender } = render(<Thinking item={{ kind: "thinking", id: "t1", text: "Checking the tests", streaming: true }} />);
    expect(screen.getByText("Thinking…")).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(true);
    rerender(<Thinking item={{ kind: "thinking", id: "t1", text: "Checking the tests", streaming: false }} />);
    expect(screen.getByText("Reasoning")).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(false);
  });

  it("comes back from a saved session", () => {
    const items = fromTranscript([{ kind: "user", text: "hi" }, { kind: "thinking", text: "A greeting." }, { kind: "assistant", text: "Hello" }]);
    expect(items.map((i) => i.kind)).toEqual(["user", "thinking", "assistant"]);
  });
});

describe("plan mode", () => {
  it("holds a plan until it is answered or closed, and follows the server's plan mode", () => {
    let s = run([{ type: "hello", info, running: true, demo: false }, { type: "plan_request", id: "p1", plan: "1. Do it" }]);
    expect(s.plan).toEqual({ id: "p1", plan: "1. Do it" });
    s = run([{ type: "question_closed", id: "p1" }], s);
    expect(s.plan).toBeNull();
    s = run([{ type: "plan_mode", on: true }], s);
    expect(s.info?.plan).toBe(true);
  });

  it("approves, or sends what to change", () => {
    const answerPlan = vi.fn();
    useStore.setState({ plan: { id: "p1", plan: "**Plan**\n\n1. Write `demo.py`" }, answerPlan });
    render(<PlanCard />);
    expect(screen.getByText("Plan")).toBeTruthy();
    fireEvent.click(screen.getByText(/Approve and start/));
    expect(answerPlan).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText(/Keep planning/));
    fireEvent.change(screen.getByLabelText("What should change in the plan"), { target: { value: "use tabs" } });
    fireEvent.click(screen.getByText("Send"));
    expect(answerPlan).toHaveBeenCalledWith(false, "use tabs");
  });

  it("/plan switches it, and /plan on|off sets it", () => {
    const setPlan = vi.fn();
    useStore.setState({ info, setPlan });
    useStore.getState().submit("/plan");
    expect(setPlan).toHaveBeenLastCalledWith(true);
    useStore.getState().submit("/plan off");
    expect(setPlan).toHaveBeenLastCalledWith(false);
  });

  it("/clear starts a fresh session", () => {
    const newSession = vi.fn();
    useStore.setState({ newSession });
    expect(useStore.getState().submit("/clear")).toBe(true);
    expect(newSession).toHaveBeenCalled();
  });
});

describe("attachments", () => {
  it("a sent message shows its files; a reloaded one shows their names", () => {
    const items = fromTranscript([{ kind: "user", text: "what is this?", attachments: [{ name: "shot.png", kind: "image" }] }]);
    expect(items[0]).toMatchObject({ kind: "user", attachments: [{ name: "shot.png", kind: "image" }] });
    render(<Message item={items[0]} />);
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.getByText("what is this?")).toBeTruthy();
  });

  it("a message can be only files, and a slash at the start is then text, not a command", () => {
    const newSession = vi.fn();
    useStore.setState({ newSession });
    const files = [{ id: "a1", name: "x.txt", kind: "text" as const, size: 3 }];
    useStore.getState().submit("/clear", files);  // not connected: nothing is sent, but it was not taken as a command
    expect(newSession).not.toHaveBeenCalled();
  });
});
