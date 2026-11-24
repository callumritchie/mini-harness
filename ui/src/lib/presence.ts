import { useEffect, useState } from "react";

/** Keep a panel on screen for `ms` after it is told to close, with `closing` set, so it can leave the way it came in. `animate` is
 *  asked at the moment of closing: when it says no (a docked panel, reduced motion, a keyboard shortcut) the panel goes at once.
 *  Reopening while it is still leaving just turns it round: it was never unmounted, so its transition retargets. */
export function usePresence(open: boolean, animate: () => boolean, ms = 200): { mounted: boolean; closing: boolean } {
  const [leaving, setLeaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  useEffect(() => {
    if (open) {
      setWasOpen(true);
      setLeaving(false);
      return;
    }
    if (!wasOpen) return;
    setWasOpen(false);
    if (!animate()) return;
    setLeaving(true);
    const t = setTimeout(() => setLeaving(false), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // the render that first sees open=false still shows the panel; the effect then decides whether it leaves or goes now
  const mounted = open || leaving || (wasOpen && !open && animate());
  return { mounted, closing: !open && mounted };
}

/** Whether the person asked for less motion. */
export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Whether the window is at most `px` wide, matching a CSS max-width breakpoint. */
export const narrowerThan = (px: number) => typeof window !== "undefined" && window.matchMedia?.(`(max-width: ${px}px)`).matches === true;
