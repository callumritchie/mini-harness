import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { usePresence } from "../src/lib/presence";

afterEach(() => { cleanup(); vi.useRealTimers(); });

function Panel({ open, animate }: { open: boolean; animate: boolean }) {
  const { mounted, closing } = usePresence(open, () => animate, 200);
  return mounted ? <aside className={closing ? "closing" : ""}>panel</aside> : null;
}

describe("usePresence", () => {
  it("keeps a closing drawer on screen until it has slid out, then removes it", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Panel open animate />);
    rerender(<Panel open={false} animate />);
    expect(container.querySelector("aside.closing")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(199); });
    expect(container.querySelector("aside")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(container.querySelector("aside")).toBeNull();
  });

  it("removes it at once when it should not animate (docked, a shortcut, reduced motion)", () => {
    const { container, rerender } = render(<Panel open animate={false} />);
    rerender(<Panel open={false} animate={false} />);
    expect(container.querySelector("aside")).toBeNull();
  });

  it("turns round when reopened while leaving, without remounting", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Panel open animate />);
    const before = container.querySelector("aside");
    rerender(<Panel open={false} animate />);
    act(() => { vi.advanceTimersByTime(100); });
    rerender(<Panel open animate />);
    const after = container.querySelector("aside");
    expect(after).toBe(before); // the same element: its transition retargets instead of replaying the entrance
    expect(after!.className).toBe("");
    act(() => { vi.advanceTimersByTime(500); });
    expect(container.querySelector("aside")).not.toBeNull();
  });
});
